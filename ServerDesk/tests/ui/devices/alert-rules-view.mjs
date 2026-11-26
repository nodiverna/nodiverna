// The "Alert rules" area (ui/devices/monitoring/alert-rules.tsx) rendered with React SSR:
// all 39 rules on All devices, a group and a device with the default origin,
// the "Changed" tag with the inherited line, the inherited origin link, blocked
// menu entries with their reason, demo mode, error texts by code, the
// number and level fields of the edit drawer with aria-describedby, the CSS of
// the sticky actions column and the unit field frame, and the
// routes #devices/alerts and #devices/group/<id>/alerts, and the customer origin, its link and the customer-right
// reason. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const panel=await import('../../../ui/devices/monitoring/alert-rules.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const rules=await import('../../../lib/alert-rules.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {ApiError}=await import('../../../ui/base/http.ts');
const route=await import('../../../lib/console-route.ts');
const fleetSource=(await import('node:fs')).readFileSync(new URL('../../../ui/devices/fleet/fleet.tsx',import.meta.url),'utf8');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const groupId='10000000-0000-4000-8000-000000000001',parentId='10000000-0000-4000-8000-000000000002',deviceId='20000000-0000-4000-8000-000000000001';
const noop=()=>{};
const render=(view,scope,locale='en',actions={})=>renderToStaticMarkup(h(LocaleProvider,{locale},h(panel.AlertRulesTable,{view,scope,onEdit:noop,onReset:noop,onOpenOrigin:noop,...actions})));
// The DataTable rows carry no rule id; they come in catalog order (the order of the view's rules).
// The rows rise in once (entranceId alert-rule-rows): the tbody and its rows may carry the entrance class and delay.
const rows=html=>{const body=html.slice(html.indexOf('<tbody'),html.indexOf('</tbody>'));return [...body.matchAll(/<tr(?: [^>]*)?>(.*?)<\/tr>/g)].map((match,index)=>({id:rules.alertRuleIds[index],html:match[1]}));};
const cells=row=>[...row.html.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(match=>match[1]);
const text=value=>value.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&');

// ---- All 39 rules with the muted default origin on all three levels ----
for(const scope of [{type:'global',id:'*'},{type:'group',id:groupId},{type:'device',id:deviceId}]){
 const view=rules.defaultAlertRuleView({...scope,name:'X'});
 const html=render(view,scope),list=rows(html);
 check(list.map(row=>row.id),rules.alertRuleIds,`${scope.type}: 39 rules in catalog order`);
 check(list.every(row=>cells(row).at(-2)==='<span class="sdx-muted-cell">Default</span>'),true,`${scope.type}: origin Default everywhere, as muted text`);
 ok(/^<div class="sdx-table-wrap sdx-alert-rules-table sdx-table-sticky-actions" role="region" aria-label="Alert rules" tabindex="0"><table class="sdx-table sdx-data-table">/.test(html),`${scope.type}: a DataTable region (the direct table of the tab, not flush) with the sticky actions modifier`);
 ok(!/<small/.test(html.slice(html.indexOf('<tbody>'))),`${scope.type}: no description line in the rows`);
 ok(/<th scope="col" class="sdx-col-actions">(?:(?!<th).)*<\/th><\/tr><\/thead>/.test(html),`${scope.type}: the last header cell is the actions column`);
 check(list.filter(row=>/<td class="sdx-col-actions">(?:(?!<td).)*<\/td>$/.test(row.html)).length,39,`${scope.type}: the last cell of each of the 39 rows is the actions column`);
 check([...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>text(match[1])),['Rule','Warning','Critical','Alarm','Level','Status','Origin','Actions'],`${scope.type}: columns`);
}
const defaults=rules.defaultAlertRuleView({type:'global',id:'*',name:''}),html=render(defaults,{type:'global',id:'*'});
const byId=Object.fromEntries(rows(html).map(row=>[row.id,cells(row).map(text)]));
check(byId.cpu.slice(0,6),['CPU usage','80 %','90 %','After 5 minutes, recovery 5 %','By threshold','On'],'threshold row: the name only, then the Alarm column');
check([byId['disk-free'][3],byId['signatures-age'][3],byId['processor-queue'][3],byId['crash-recent'][3]],['Immediately, recovery 2 %','Immediately','After 5 minutes','—'],'Alarm summaries; the age rules have none');
check(byId['device-offline'].slice(0,6),['Device offline','—','15 minutes','—','By threshold','On'],'the rule Device offline, last, without alarm settings');
check(byId['disk-free'].slice(1,3),['15 %','5 %'],'disk-free thresholds');
check(byId['disk-latency'].slice(1,3),['50 ms','100 ms'],'latency in ms');
check(byId['signatures-age'].slice(1,3),['7 days','—'],'days and an unused step');
check(byId['processor-queue'].slice(1,3),['2 threads per processor','—'],'threads per processor');
check(byId['reboot-pending'].slice(1,6),['—','—','—','Warning','On'],'boolean row: no thresholds and no alarm settings');
check(byId['inventory-incomplete'][4],'Info','boolean level info');
// The limit kind: its one threshold under Warning, "Not used" under Critical, then Alarm, Level and Status.
check(byId['battery-capacity'].slice(0,6),['Battery capacity','60 %','—','—','Info','On'],'limit row: one threshold, no alarm settings, the level');
const battery=rows(html).find(row=>row.id==='battery-capacity');
check(cells(battery).slice(1,3),['<span class="sdx-alert-limit" role="group" aria-label="Threshold"><span class="mono">60 %</span></span>','<span class="sdx-muted-cell" role="img" aria-label="Not used">—</span>'],'the limit threshold is named "Threshold"; Critical is not used');
check(byId['cert-expiring-no-key'].slice(1,6),['30 days','7 days','—','By threshold','Off'],'cert-expiring-no-key is off by default');
ok(/<span class="sdx-pill sdx-pill-success"><i aria-hidden="true"><\/i>On<\/span>/.test(html)&&/<span class="sdx-pill sdx-pill-neutral"><i aria-hidden="true"><\/i>Off<\/span>/.test(html),'Status is a pill: success "On", neutral "Off"');
check([...html.matchAll(/<th scope="col" class="sdx-hide-below-1280[^"]*">(.*?)<\/th>/g)].map(match=>text(match[1])),['Alarm'],'Alarm hides below 1280px');
check([...html.matchAll(/<th scope="col" class="sdx-hide-below-1440">(.*?)<\/th>/g)].map(match=>text(match[1])),['Level'],'Level hides below 1440px, so the table fits next to the tree at 1280px');
check([byId['stability-low'][1],byId['app-crash-repeated'][1],byId['ssd-wear'].slice(1,3).join(' / ')],['5','3','80 % / 95 %'],'index and count thresholds as plain numbers');
ok(/<span class="sdx-muted-cell" role="img" aria-label="Not used">—<\/span>/.test(html),'an unused step is labelled "Not used"');
const german=render(defaults,{type:'global',id:'*'},'de');
check(text(cells(rows(german).find(row=>row.id==='disk-free'))[0]),'Freier Speicherplatz','German row');
ok(german.includes('<i aria-hidden="true"></i>Ein</span>')&&german.includes('Standard')&&german.includes('Nach Schwellenwert')&&german.includes('Herkunft'),'German labels');

// ---- Overrides: "Changed" with the inherited line, inherited origin link ----
const view=structuredClone(defaults);view.scope={type:'group',id:groupId,name:'Child'};view.canEdit=true;
const cpu=view.rules.find(row=>row.ruleId==='cpu');
Object.assign(cpu,{effective:{enabled:true,warning:60,critical:95,level:null,durationMinutes:10,recovery:3},origin:{type:'group',id:groupId,name:'Child',visible:true},override:{enabled:true,warning:60,critical:95,level:null,durationMinutes:10,recovery:3,updatedAt:5},inherited:{settings:{enabled:true,warning:70,critical:85,level:null,durationMinutes:5,recovery:5},origin:{type:'global',id:'*',name:'',visible:true}}});
const memory=view.rules.find(row=>row.ruleId==='memory');
Object.assign(memory,{effective:{enabled:false,warning:80,critical:90,level:null,durationMinutes:5,recovery:5},origin:{type:'group',id:parentId,name:'Parent',visible:true},inherited:{settings:{enabled:false,warning:80,critical:90,level:null,durationMinutes:5,recovery:5},origin:{type:'group',id:parentId,name:'Parent',visible:true}}});
const pagefile=view.rules.find(row=>row.ruleId==='pagefile');
Object.assign(pagefile,{origin:{type:'group',id:parentId,name:'Parent',visible:false}});
const disk=view.rules.find(row=>row.ruleId==='disk-free');
Object.assign(disk,{origin:{type:'global',id:'*',name:'',visible:true}});
const scope={type:'group',id:groupId};
const overridden=Object.fromEntries(rows(render(view,scope)).map(row=>[row.id,cells(row)]));
ok(overridden.cpu[6].includes('<span class="sdx-tag sdx-tag-changed">Changed</span>'),'a direct override has the Changed tag');
check(text(overridden.cpu[6]),'ChangedInherited: Warning 70 %, critical 85 % · After 5 minutes, recovery 5 % from All devices','and the muted inherited line with the alarm settings');
check(text(overridden.cpu[3]),'After 10 minutes, recovery 3 %','the effective alarm settings');
check(text(overridden.cpu[1]),'60 %','the effective value is shown first');
ok(overridden.memory[6].includes('class="sdx-inherited-link"')&&overridden.memory[6].includes('aria-label="Open Device group: Parent"'),'a higher origin shows InheritedOrigin with a link');
ok(!overridden.memory[6].includes('You can change or remove this only where it is set.'),'inherited rows here are editable, so the locked hint is left out');
check(text(overridden.memory[5]),'Off','a disabled rule says Off');
check(text(overridden.memory[0]),'RAM usage','the rule cell holds the name only');
const source=(await import('node:fs')).readFileSync(new URL('../../../ui/devices/monitoring/alert-rules.tsx',import.meta.url),'utf8');
ok(/\{id:'description',label:t\('alertRules\.column\.rule'\),table:false,cell:item=>alertRuleDescription\(/.test(source),'the description is a card fact "Rule" only (table:false), and stays in the drawer');
ok(!overridden.pagefile[6].includes('sdx-inherited-link')&&overridden.pagefile[6].includes('<span class="sdx-inherited-label">Device group: Parent</span>'),'an origin the viewer cannot open is plain text');
ok(text(overridden['disk-free'][6]).includes('All devices'),'All devices as origin');
check(text(overridden.cpu[6]).includes('Default'),false,'no default label on a changed row');

// ---- Row menu ----
const t=(key,params)=>translate('en',key,params),calls=[];
const actions={blocked:undefined,onEdit:item=>calls.push(['edit',item.ruleId]),onReset:item=>calls.push(['reset',item.ruleId]),onOpenOrigin:origin=>calls.push(['origin',origin])};
const ids=entries=>entries.map(entry=>entry.id);
check(ids(panel.alertRuleMenu(cpu,scope,t,actions)),['edit','reset'],'direct override: edit and reset, no origin');
check(ids(panel.alertRuleMenu(memory,scope,t,actions)),['edit','origin'],'inherited from a parent: edit and open origin');
check(ids(panel.alertRuleMenu(pagefile,scope,t,actions)),['edit'],'an invisible origin has no open entry');
check(ids(panel.alertRuleMenu(view.rules.find(row=>row.ruleId==='firewall-off'),scope,t,actions)),['edit'],'default: only edit');
const [edit,resetEntry]=panel.alertRuleMenu(cpu,scope,t,actions);
check([edit.label,resetEntry.label],['Edit rule','Reset to inherited value'],'menu labels');
edit.onSelect();resetEntry.onSelect();panel.alertRuleMenu(memory,scope,t,actions).at(-1).onSelect();
check(calls,[['edit','cpu'],['reset','cpu'],['origin',{type:'group',id:parentId,name:'Parent',visible:true}]],'the entries call their actions');
const right=t('alertRules.blocked.right'),blockedEntries=panel.alertRuleMenu(cpu,scope,t,{...actions,blocked:right});
check(blockedEntries.map(entry=>[entry.id,entry.blocked]),[['edit',right],['reset',right]],'without canEdit the entries stay visible and blocked with the reason');
calls.length=0;blockedEntries.forEach(entry=>entry.onSelect());check(calls,[],'blocked entries do nothing');
check(panel.alertRuleMenu(memory,scope,t,{...actions,blocked:right}).at(-1).blocked,undefined,'"Open origin" is never blocked');
check(panel.alertOriginIsHigher({type:'global',id:'*',name:'',visible:true},{type:'global',id:'*'}),false,'All devices is not higher than itself');
check(panel.alertOriginIsHigher({type:'group',id:parentId,name:'',visible:true},{type:'device',id:deviceId}),true,'a group is higher than a device');

// ---- The customer level ----
const customerOrigin={type:'customer',id:'c1',name:'Contoso',visible:true};
check([panel.alertOriginLabel(customerOrigin,t),panel.alertOriginLabel(customerOrigin,(key,params)=>translate('de',key,params))],['Customer: Contoso','Kunde: Contoso'],'customer origin label');
check([{type:'customer',id:'c1'},{type:'group',id:parentId},{type:'device',id:deviceId},{type:'global',id:'*'}].map(target=>panel.alertOriginIsHigher(customerOrigin,target)),[false,true,true,false],'a customer origin is higher on a group or device, not on the customer itself or All devices');
check(panel.alertOriginIsHigher({type:'global',id:'*',name:'',visible:true},{type:'customer',id:'c1'}),true,'All devices is higher than a customer');
const fromCustomer={...memory,origin:customerOrigin};
check(ids(panel.alertRuleMenu(fromCustomer,scope,t,{...actions,customerView:true})),['edit','origin'],'a visible customer origin with the customer view: Open origin');
check(ids(panel.alertRuleMenu(fromCustomer,scope,t,actions)),['edit'],'without the customer view the customer origin does not open');
check(ids(panel.alertRuleMenu({...fromCustomer,origin:{...customerOrigin,visible:false}},scope,t,{...actions,customerView:true})),['edit'],'an invisible customer origin does not open');
calls.length=0;panel.alertRuleMenu(fromCustomer,scope,t,{...actions,customerView:true}).at(-1).onSelect();
check(calls,[['origin',customerOrigin]],'Open origin hands the customer origin to the console');
const customerRight=t('alertRules.blocked.customerRight');
check(panel.alertRuleMenu({...cpu,origin:customerOrigin},{type:'customer',id:'c1'},t,{...actions,blocked:customerRight,customerView:true}).map(entry=>[entry.id,entry.blocked]),[['edit',customerRight],['reset',customerRight]],'edit and reset blocked with the customer-right reason');
check(customerRight,'To change the rules of a customer, you need the permission “Manage alert rules and alarms” on all devices.','the customer-right text');
const customerView={...view,rules:view.rules.map(row=>row.ruleId==='memory'?fromCustomer:row)};
const customerTable=render(customerView,scope,'en',{customerView:true,onOpenOrigin:noop});
ok(customerTable.includes('aria-label="Open Customer: Contoso"'),'the origin cell links a customer origin with the customer view');
ok(render(customerView,scope).includes('<span class="sdx-inherited-label">Customer: Contoso</span>'),'without it the customer origin is plain text');
ok(!/readOnly[?:=]|ReadOnlyOrigin|alertRules\.customer\.notice/.test(source),'no readOnly prop, ReadOnlyOrigin or customer notice is left');

// ---- Reasons and error texts by code ----
check([t('alertRules.blocked.right'),t('alertRules.blocked.boundary'),t('alertRules.blocked.readOnly'),t('kit.unavailable.demo')],['To change alert rules here, you need the permission “Manage alert rules and alarms”.','Rules on All devices apply to every customer. Only an account that sees all customers can change them.','The portal is in read-only mode. You cannot change alert rules now.','Not available for sample devices.'],'blocked reasons');
check([new ApiError('x',400,'ALERT_RULE_INVALID'),new ApiError('x',409,'ALERT_RULE_CHANGED'),new ApiError('x',403,'ALERT_RULE_SCOPE_BOUNDARY'),new ApiError('x',403),new ApiError('Device not found.',404)].map(error=>panel.alertRuleFailure(error,t)),
 ['The values are not valid. Check the thresholds and try again.','Someone changed this rule in the meantime. Reload the rules and try again.',t('alertRules.blocked.boundary'),t('alertRules.blocked.right'),'Device not found.'],'failure texts by code');
check(panel.alertOriginLabel({type:'device',id:deviceId,name:'SRV-1',visible:true},(key,params)=>translate('de',key,params)),'Gerät: SRV-1','device origin label');

// ---- Demo and loading: the panel without server data ----
const demoHtml=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(panel.default,{scope:{type:'global',id:'*'},scopeName:'All devices',demo:true,onRefresh:noop,onOpenOrigin:noop})));
check(rows(demoHtml).length,39,'demo mode shows the 39 default rules');
ok(/<section class="sdx-health-tab sdx-alert-rules" aria-labelledby="([^"]+)"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="\1" class="sr-only">Alert rules<\/h2><p>Alert rules decide when a device shows an issue\. A value that you change here applies to this level and everything below it/.test(demoHtml),'the shared analysis frame (AnalysisTab): the sr-only h2 is the section label, the description is visible');
ok(!demoHtml.includes('sdx-btn-primary'),'no gradient primary inside the subtab');
ok(!demoHtml.includes('sdx-alert-rules-head'),'no own head');
ok(!demoHtml.includes('sdx-card')&&/<\/header><div class="sdx-table-wrap sdx-alert-rules-table/.test(demoHtml),'the table is the direct child of the tab, not inside a Card');
const loadingHtml=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(panel.default,{scope:{type:'group',id:groupId},scopeName:'Child',demo:false,onRefresh:noop,onOpenOrigin:noop})));
ok(/<div class="sdx-skeleton-set sdx-skeleton-table" role="status" aria-label="Loading alert rules">/.test(loadingHtml)&&!loadingHtml.includes('<table')&&!loadingHtml.includes('sdx-loading'),'before the first answer FirstLoad: the kit Skeleton (table) with role status');
{
 const source=(await import('node:fs')).readFileSync(new URL('../../../ui/devices/monitoring/alert-rules.tsx',import.meta.url),'utf8');
 ok(/<FirstLoad label=\{t\('alertRules\.loading'\)\}/.test(source)&&/<LoadFailed text=\{view\?<>\{t\('alertRules\.loadFailed'\)\} \{t\('alertRules\.staleData'\)\}<\/>:t\('alertRules\.loadFailed'\)\}/.test(source)&&!/<Card/.test(source)&&source.includes('entranceId="alert-rule-rows"'),'the panel uses FirstLoad and LoadFailed (with the stale sentence) and no Card around the table');
}

// ---- Load error: "Try again" repeats the request and keeps the rules ----
{
 const {panelHarness}=await import('../../support/panel-harness.mjs');
 const urls=[];let fail=true;
 const stubs={'@/ui/base/api':{ApiError,message:error=>error.message,api:url=>{urls.push(url);return fail?Promise.reject(new Error('down')):Promise.resolve(rules.defaultAlertRuleView({type:'group',id:groupId,name:'Child'}));}}};
 for(const [locale,label] of [['de','Erneut versuchen'],['en','Try again']]){
  const harness=panelHarness({hooked:['ui/devices/monitoring/alert-rules.tsx'],stubs,locale});
  const Panel=harness.load('ui/devices/monitoring/alert-rules.tsx').default,props={scope:{type:'group',id:groupId},scopeName:'Child',demo:false,onRefresh:noop,onOpenOrigin:noop};
  harness.reset();urls.length=0;fail=true;harness.tree(Panel,props);await harness.flush();await new Promise(resolve=>setTimeout(resolve,0));await harness.settle();
  // The shared LoadFailed: its Notice with the retry "Try again" that repeats the same request.
  let tree=harness.tree(Panel,props);const failed=harness.find(tree,item=>typeof item.props.onRetry==='function'&&'text' in item.props);
  ok(failed&&harness.html(Panel,props).includes(label)&&harness.html(Panel,props).includes('sdx-notice')&&!harness.html(Panel,props).includes('<table'),`${locale}: the load error is LoadFailed and offers "${label}"`);
  fail=false;failed.props.onRetry();await harness.settle();tree=harness.tree(Panel,props);
  check([urls.length,urls[0]===urls[1]],[2,true],`${locale}: the retry repeats the same request`);
  ok(harness.html(Panel,props).includes('sdx-data-table'),`${locale}: the rules show after the retry`);
 }
}
ok(fleetSource.includes('const tab:FleetTab=shownScopeTab(requestedTab,present);')&&fleetSource.includes('alerts:!!alerts}'),'the fleet falls back to devices without the alerts area');

// ---- Edit drawer fields: aria-describedby always names a rendered element ----
const field=(component,props)=>renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(component,{disabled:false,onChange:noop,...props})));
const describedIds=html=>[...html.matchAll(/aria-describedby="([^"]*)"/g)].flatMap(match=>match[1].split(' '));
const numberProps={id:'f-warning',label:'Warning',value:'80',hint:'Leave empty to switch the level off.',unit:'%',min:0,max:100};
const numberHint=field(panel.AlertRuleNumberField,{...numberProps,error:''});
check(describedIds(numberHint),['f-warning-hint'],'number field without an error: described by its hint');
ok(numberHint.includes('<small id="f-warning-hint">Leave empty to switch the level off.</small>'),'the hint is rendered with its id');
ok(!numberHint.includes('aria-invalid')&&!numberHint.includes('sdx-field-error'),'no aria-invalid and no error without an error');
const numberError=field(panel.AlertRuleNumberField,{...numberProps,error:'Enter a whole number from 0 to 100.'});
check(describedIds(numberError),['f-warning-error'],'number field with an error: described by its error');
ok(numberError.includes('<span class="sdx-field-error" id="f-warning-error">Enter a whole number from 0 to 100.</span>'),'the error text is inside the referenced element');
ok(numberError.includes('aria-invalid="true"')&&!numberError.includes('<small'),'aria-invalid with an error; the error replaces the hint');
const levelPlain=field(panel.AlertRuleLevelField,{id:'f-level',label:'Level',value:'warning',error:''});
ok(/<select id="f-level"/.test(levelPlain),'the level select has an id');
check(describedIds(levelPlain),[],'level without an error: no aria-describedby');
ok(!levelPlain.includes('aria-invalid')&&!levelPlain.includes('sdx-field-error'),'level without an error: no aria-invalid, no error');
const levelError=field(panel.AlertRuleLevelField,{id:'f-level',label:'Level',value:'warning',error:'Choose a level.'});
check(describedIds(levelError),['f-level-error'],'level with an error: described by its error');
ok(levelError.includes('<span class="sdx-field-error" id="f-level-error">Choose a level.</span>')&&levelError.includes('aria-invalid="true"'),'level error inside the referenced element, aria-invalid');
for(const [html,state] of [[numberHint,'hint'],[numberError,'error']]){
 const unit=html.match(/<span class="sdx-input-unit">(.*?)<\/span><(?:small|span class="sdx-field-error")/)?.[1]??'';
 ok(/^<input id="f-warning" type="number"[^>]*\/><span aria-hidden="true">%<\/span>$/.test(unit),`number field with ${state}: the unit frame holds exactly the input and the aria-hidden unit`);
}
for(const html of [numberHint,numberError,levelPlain,levelError])for(const id of describedIds(html))ok(html.includes(`id="${id}"`),`aria-describedby ${id} exists in the markup`);

// ---- CSS: sticky actions column and the number field frame ----
const css=(await import('node:fs')).readFileSync(new URL('../../../ui/styles/console.css',import.meta.url),'utf8');
// Single-line rule blocks whose selector matches, joined; the file writes one rule per line.
const blocks=selector=>[...css.matchAll(/^([^{}\n]+)\{([^}]*)\}/gm)].filter(match=>selector.test(match[1].trim())).map(match=>({selector:match[1].trim(),body:match[2]}));
const rule=(selector,label)=>{const found=blocks(selector);ok(found.length>0,`css: ${label} exists`);return found.map(block=>block.body).join(';');};
const sticky=rule(/\.sdx-table-sticky-actions \.sdx-col-actions$/,'sticky actions rule');
ok(/position: sticky/.test(sticky)&&/right: 0/.test(sticky),'sticky actions: position sticky at right 0');
ok(sticky.includes('inset 1px 0 0 var(--sd-soft-line)'),'sticky actions: a leading 1px separator in --sd-soft-line');
const stickyHead=rule(/\.sdx-table-sticky-actions th\.sdx-col-actions$/,'sticky header cell');
ok(Number(stickyHead.match(/z-index: (\d+)/)?.[1])>1,'sticky header cell: z-index above the other header cells');
ok(stickyHead.includes('background: color-mix(in srgb, var(--sd-ink) 2%, var(--sd-panel))'),'sticky header cell: the header background');
ok(rule(/\.sdx-table-sticky-actions td\.sdx-col-actions$/,'sticky body cell').includes('background: var(--sd-panel)'),'sticky body cell: opaque panel');
ok(rule(/\.sdx-table-sticky-actions tbody tr:hover > td\.sdx-col-actions$/,'sticky hover cell').includes('background: color-mix(in srgb, var(--sd-accent) 3.5%, var(--sd-panel))'),'sticky body cell on hover: the row hover background');
check(css.match(/^\.sdx-col-actions \{[^}]*\}/m)?.[0],'.sdx-col-actions { width: 44px; text-align: right !important; }','the shared actions column rule is unchanged');
check(blocks(/^\.sdx-col-actions$/).some(block=>/sticky/.test(block.body)),false,'the shared actions column is not sticky');
const frame=rule(/\.sdx-input-unit$/,'unit frame');
for(const property of ['border: 1px solid var(--sd-line)','border-radius: var(--sd-radius-sm)','background: var(--sd-panel)','box-shadow: var(--sd-shadow-sm)','min-height: 36px','width: 100%'])ok(frame.includes(property),`unit frame: ${property}`);
ok(rule(/\.sdx-input-unit:focus-within$/,'unit frame focus').includes('box-shadow: 0 0 0 3px color-mix(in srgb, var(--sd-accent) 18%, transparent)'),'unit frame: the focus halo on :focus-within');
const inner=rule(/\.sdx-input-unit > input$/,'input inside the frame');
ok(/border: (?:0|none);/.test(inner)&&/box-shadow: none/.test(inner)&&/background: transparent/.test(inner)&&/flex: 1;/.test(inner)&&/min-width: 0/.test(inner),'input inside the frame: no own border, shadow or background; fills the rest');
ok(/box-shadow: none/.test(rule(/\.sdx-input-unit > input:focus$/,'input focus inside the frame')),'input inside the frame: no own focus halo');
const unitText=rule(/^\.sdx-input-unit > span$/,'unit text');
ok(/padding-right: 11px/.test(unitText)&&/white-space: nowrap/.test(unitText)&&/color: var\(--sd-muted\)/.test(unitText),'unit text: muted, trailing 11px, one line');
ok(/cursor: not-allowed/.test(rule(/input:disabled$/,'disabled frame')),'disabled frame: not-allowed cursor');
ok(/align-items: start/.test(rule(/^\.sdx-alert-rule-steps$/,'field rows')),'field rows align to the top');
for(const block of blocks(/sdx-table-sticky-actions|sdx-input-unit|sdx-alert-rule-steps/)){assert.doesNotMatch(block.body,/#[0-9a-f]{3,8}\b|rgba?\(/i,`no raw colors in ${block.selector}`);checks++;}

// ---- Routes ----
check(route.parseConsoleRoute('#devices/configuration'),{view:'devices',tab:'alerts'},'the old All devices alert rules link (Configuration)');
check(route.parseConsoleRoute('#devices/monitoring/alert-rules'),{view:'devices',tab:'alerts'},'All devices alert rules (Monitoring)');
check(route.parseConsoleRoute('#devices/alerts'),{view:'devices',tab:'alerts'},'the old link');
check(route.consoleRouteHash({view:'devices',tab:'alerts'}),'#devices/monitoring/alert-rules','round trip');
check(route.parseConsoleRoute(`#devices/group/${groupId}/configuration`),{view:'devices',groupId,tab:'alerts'},'group alert rules');
check(route.consoleRouteHash({view:'devices',groupId,tab:'alerts'}),`#devices/group/${groupId}/monitoring/alert-rules`,'group round trip');
check(route.parseConsoleRoute(`#devices/group/${groupId}/unknown`),{view:'devices',groupId,tab:'devices'},'an unknown group tab falls back to devices');
check(route.parseConsoleRoute('#devices/jobs'),{view:'devices',tab:'jobs'},'old tab links still open their tab');
check(route.consoleRouteHash({view:'devices',tab:'settings'}),'#devices','a tab All devices never has is not written');
check(route.parseConsoleRoute(`#devices/${deviceId}/overview`).view,'device','old device links stay device links');
check(route.consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'monitoring',deviceDetail:'alert-rules'}),'#device/d1/monitoring/alert-rules','the device alert rules: Monitoring › Alert rules');
check(route.consoleRouteHash(route.parseConsoleRoute('#device/d1/configuration')),'#device/d1/monitoring/alert-rules','the old device alert rules link');
console.log(`PASS alert rules view (${checks} checks): 39 rules with the Alarm column and the limit cell on All devices, group and device, Changed tag and inherited line, origin links, blocked menu entries, demo, loading, error texts, the drawer field descriptions, the sticky actions column and unit frame CSS, and the alert routes.`);
