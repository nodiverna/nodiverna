// The job dock (ui/shell/jobs.tsx, JobDock) rendered with React SSR: the resize separator and
// the toggle name the panel with aria-controls only while the panel exists, so a closed dock has
// no reference to a missing id (axe aria-valid-attr-value). The rest of the separator stays. The Jobs sheet of the bottom
// bar (JobSheet, 900px or narrower): the kit modal Drawer with the dock's counts, list, empty state and "Show all jobs".
// The cancel IconBtn of a row is blocked with its reason from cancelJobBlocked (demo, permission, saving), never disabled.
import {mock} from '../../support/register.mjs';
import * as radix from 'radix-ui';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
mock('radix-ui',{...radix,Dialog:{...radix.Dialog,Portal:({children})=>children},AlertDialog:{...radix.AlertDialog,Portal:({children})=>children}});
const h=React.createElement;
const {JobDock,JobSheet}=await import('../../../ui/shell/jobs.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const noop=()=>{};
const now=Date.now();
const job={id:'j1',serverId:'s1',action:'refresh',state:'running',createdAt:now-5000,startedAt:now-4000,params:{}};
const render=open=>renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(JobDock,{jobs:[job],current:job,servers:[{id:'s1',name:'SRV-1'}],viewer:{id:'owner',label:'owner',permissions:['*']},demo:false,loaded:true,saving:false,now,open,onOpenChange:noop,onSelect:noop,onCancel:noop,onShowAll:noop})));
const tag=(html,pattern)=>html.match(pattern)?.[0]??'';
const attr=(text,name)=>text.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??null;

let html=render(false);
let separator=tag(html,/<div class="sdx-dock-resize"[^>]*>/),toggle=tag(html,/<button[^>]*class="sdx-dock-toggle"[^>]*>/);
check([attr(separator,'aria-controls'),attr(toggle,'aria-controls'),html.includes('id="sdx-dock-panel"')],[null,null,false],'closed: no panel and no aria-controls');
check([attr(separator,'role'),attr(separator,'aria-valuenow'),attr(separator,'tabindex'),attr(toggle,'aria-expanded')],['separator','0','0','false'],'closed: the separator and toggle keep their other attributes');

html=render(true);
separator=tag(html,/<div class="sdx-dock-resize"[^>]*>/);toggle=tag(html,/<button[^>]*class="sdx-dock-toggle"[^>]*>/);
check([attr(separator,'aria-controls'),attr(toggle,'aria-controls'),html.includes('id="sdx-dock-panel"')],['sdx-dock-panel','sdx-dock-panel',true],'open: both control the rendered panel');
check([attr(separator,'aria-valuenow'),attr(toggle,'aria-expanded')],['300','true'],'open: height and expanded state');

// The JobList second line holds the device, the object and the progress, never the raw kind or operation id,
// and its time is a <time> with the exact time as title.
{
 const {JobList}=await import('../../../ui/shell/jobs.tsx');
 const list=jobs=>renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(JobList,{jobs,servers:[{id:'s1',name:'SRV-1'}],viewer:{id:'owner',label:'owner',permissions:['*']},demo:false,saving:false,now,onSelect:noop,onCancel:noop})));
 const finished={id:'j2',serverId:'s1',action:'plugin-job',target:'dhcp-scope-create',state:'failed',createdAt:now-60000,claimedAt:now-50000,actor:'a',object:'10.0.0.0'};
 let markup=list([finished]);
 check(markup.match(/<small>([^<]*)<\/small>/)?.[1],'SRV-1 · 10.0.0.0','the second line: device · object');
 check(markup.includes('dhcp-scope-create'),false,'no raw operation id');
 check(/<time class="sdx-job-time" dateTime="[^"]+" title="[^"]+">/.test(markup),true,'the time with the exact time as title');
 markup=list([{...finished,id:'j3',action:'plugin-job',target:'dns-scavenging-set',object:undefined},{...finished,id:'j4',action:'plugin-job',target:'dhcp-read',object:null}]);
 check([markup.includes('dns-scavenging-set'),markup.includes('dhcp-read')],[false,false],'an old plugin job without an object shows no operation id');
}
// Cancel job says why it cannot act (cancelJobBlocked in ui/shell/console-jobs.tsx): demo, then the missing permission,
// then another change that is saving. The dock's IconBtn carries the reason as blocked, never native disabled.
{
 const {JobList}=await import('../../../ui/shell/jobs.tsx');
 const {cancelJobBlocked}=await import('../../../ui/shell/console-jobs.tsx');
 const pending={id:'p1',serverId:'s1',action:'stop-service',target:'Spooler',state:'pending',createdAt:now-1000,actor:'a',object:'Spooler'};
 const owner={id:'owner',label:'owner',permissions:['*']},reader={id:'reader',label:'reader',permissions:[]};
 const allowed=[{id:'s1',name:'SRV-1',permissions:['view','manage']}],denied=[{id:'s1',name:'SRV-1',permissions:['view']}];
 check([
  cancelJobBlocked(pending,allowed,owner,{demo:true,saving:true}),
  cancelJobBlocked(pending,denied,reader,{demo:true,saving:false}),
  cancelJobBlocked(pending,denied,reader,{demo:false,saving:true}),
  cancelJobBlocked(pending,allowed,owner,{demo:false,saving:true}),
  cancelJobBlocked(pending,allowed,owner,{demo:false,saving:false}),
 ],['kit.unavailable.demo','kit.unavailable.demo','jobs.cancel.blockedPermission','kit.busy',null],'cancelJobBlocked: demo first, then the permission, then saving, else null');
 const cancelButton=html=>html.match(/<button[^>]*aria-label="Cancel job"[^>]*>/)?.[0]??'';
 const dock=(extra={})=>renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(JobList,{jobs:[pending],servers:allowed,viewer:owner,demo:false,saving:false,now,onSelect:noop,onCancel:noop,...extra})));
 for(const [extra,reason,label] of [[{demo:true},'Not available for sample devices.','demo'],[{saving:true},'Wait until the other change is saved.','while saving'],[{servers:denied,viewer:reader},null,'without the right']]){
  const markup=dock(extra),button=cancelButton(markup);
  ok(button.includes('aria-disabled="true"')&&!/\sdisabled=""/.test(button),`${label}: the dock cancel is blocked (aria-disabled), never natively disabled`);
  if(reason)ok(markup.includes(reason),`${label}: the reason is its description`);
 }
 const free=cancelButton(dock());
 ok(free&&!free.includes('aria-disabled')&&!/\sdisabled=""/.test(free),'with the right: the dock cancel acts');
}
// The job rows take their density from the tokens.
{
 const css=(await import('node:fs')).readFileSync('ui/styles/console.css','utf8');
 const rule=selector=>css.match(new RegExp(String.raw`^${selector.replace('.','\\.')} \{([^}]*)\}`,'m'))?.[1]??'';
 const row=rule('.sdx-job-row'),list=rule('.sdx-job-list');
 check([row.includes('min-height: var(--sd-row-h-2)'),row.includes('padding: 0 var(--sd-space-3)'),list.includes('padding: var(--sd-space-1)')],[true,true,true],'the row height and the paddings are tokens');
 check([...css.matchAll(/^\.sdx-job-[^{]*\{([^}]*)\}/gm)].some(match=>/(?:^|;)\s*(?:padding|height|min-height)[^;]*\d+px/.test(match[1])),false,'no literal pixel row height or padding in the .sdx-job-* rules');
}

// ---- The Jobs sheet ----
const sheet=(jobs,locale='en',open=true)=>renderToStaticMarkup(h(LocaleProvider,{locale},h(JobSheet,{jobs,servers:[{id:'s1',name:'SRV-1'}],viewer:{id:'owner',label:'owner',permissions:['*']},demo:false,saving:false,now,open,onClose:noop,onSelect:noop,onCancel:noop,onShowAll:noop})));
const waiting={id:'j2',serverId:'s1',action:'refresh',state:'pending',createdAt:now-2000,params:{}},done={id:'j3',serverId:'s1',action:'refresh',state:'succeeded',createdAt:now-90000,params:{}};
html=sheet([done,job,waiting]);
check([/<div role="dialog"[^>]*class="sdx-layer sdx-drawer"/.test(html),html.includes('sdx-drawer-scrim'),html.includes('sdx-drawer-nonmodal')],[true,true,false],'a modal kit Drawer with its scrim');
check([/<h2[^>]*>Jobs<\/h2>/.test(html),/<p[^>]*>1 running · 1 waiting<\/p>/.test(html),/lucide-activity/.test(html.slice(0,html.indexOf('</header>')))],[true,true,true],'title Jobs, the dock counts as the description, the Activity icon tile');
check((html.match(/class="sdx-job-row"/g)??[]).length,3,'the JobList rows of the dock');
ok(html.indexOf('Running')>0&&html.indexOf('Running')<html.indexOf('Waiting')&&html.indexOf('Waiting')<html.indexOf('Succeeded'),'active jobs first, then the finished ones');
check(/<footer class="sdx-drawer-foot"><button[^>]*class="sdx-btn sdx-btn-secondary"[^>]*><span>Show all jobs<\/span>/.test(html),true,'the footer: Show all jobs');
html=sheet([]);
ok(html.includes('No jobs yet')&&html.includes('A job appears here when you start an action on a device.'),'empty: No jobs yet with its hint');
ok(sheet([job],'de').includes('Alle Aufträge anzeigen')&&sheet([job],'de').includes('1 läuft · 0 warten'),'German: Alle Aufträge anzeigen and the counts');
ok(!sheet([job],'en',false).includes('role="dialog"'),'closed: nothing renders');

console.log(`PASS jobs dock (${checks} checks): aria-controls only while the dock panel is rendered; the JobList second line with the object and the <time> title; the job row density from the tokens; the Jobs sheet with title, counts, list, empty state and Show all jobs.`);
