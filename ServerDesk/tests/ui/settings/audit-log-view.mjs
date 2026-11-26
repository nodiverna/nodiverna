// Settings › Audit log on the kit (ui/settings/audit-log.tsx), run on hook cells: one SettingsPage with the full-width
// ActivityTable, the table Skeleton while the console loads, no shadcn import, the Area column only while a second customer exists,
// the empty state, and "Load older entries": shown at 100 rows, the cursor of the oldest row, rows appended with the
// page kept, a failure toast that keeps the rows, a short answer that hides the button, a refresh that resets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const requests=[];
const harness=panelHarness({hooked:['ui/settings/audit-log.tsx','ui/devices/history/activity-table.tsx'],stubs:{'@/ui/base/api':{api:url=>{requests.push(url);return Promise.resolve({audit:[]});},message:error=>error.message}}});
const {default:AuditLogPage,auditPageLimit}=harness.load('ui/settings/audit-log.tsx');
const now=1800000000000;
const row=(id,extra)=>({id,at:now-id*1000,actor:'owner@example.test',action:'auth.login',target:'',scope:'portal',serverId:null,...extra});
const first=Array.from({length:100},(_,index)=>row(index+1));
const heads=markup=>[...markup.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>text(match[1]));
const source=fs.readFileSync('ui/settings/audit-log.tsx','utf8');

// ---- the page frame ----
ok(!/components\/ui\//.test(source),'no components/ui import');
ok(source.includes('<SettingsPage')&&source.includes('wide={'),'one SettingsPage with the table in wide');
ok(!/<h1/.test(source),'no own h1');
harness.reset();let markup=harness.html(AuditLogPage,{entries:[],loading:true});
ok(markup.includes(`aria-label="${de('access.auditLoading')}"`)&&markup.includes('sdx-skeleton-table')&&!markup.includes('role="region"'),'the first load: the table Skeleton with access.auditLoading');
harness.reset();markup=harness.html(AuditLogPage,{entries:[row(1),row(2,{customerName:'Contoso',customerId:'c'})],multipleCustomers:true});
ok(/^<div class="sdx-settings-page"><div class="sdx-settings"><\/div><div class="sdx-settings-wide">/.test(markup)&&/aria-label="Audit-Protokoll"/.test(markup),'the labelled table in the wide slot');
check(heads(markup),['Zeit','Konto','Bereich','Aktion','Ziel'],'the Area column while a second customer exists');
ok(text(markup).includes('Contoso')&&text(markup).includes('Portal'),'Area: the customer or Portal');
// A deleted customer (removed_customers): its last name with "(gelöscht)".
harness.reset();markup=harness.html(AuditLogPage,{entries:[row(1,{customerName:'Acme',customerId:'c-gone',customerRemoved:true}),row(2,{customerName:'Contoso',customerId:'c'})],multipleCustomers:true});
ok(text(markup).includes('Acme (gelöscht)')&&!text(markup).includes('Contoso (gelöscht)'),'Area: a deleted customer shows "Acme (gelöscht)"');
harness.reset();markup=harness.html(AuditLogPage,{entries:[row(1)]});
check(heads(markup),['Zeit','Konto','Aktion','Ziel'],'no Area column without a customer');
// One customer (ConsoleData.multipleCustomers false): an entry of the default customer, such as installer.create, shows no area.
harness.reset();markup=harness.html(AuditLogPage,{entries:[row(1,{action:'installer.create',customerName:'Standardkunde',customerId:'00000000-0000-4000-8000-000000000100'})],multipleCustomers:false});
check(heads(markup),['Zeit','Konto','Aktion','Ziel'],'one customer: no Area column, also for an entry with a customer');
ok(!text(markup).includes('Standardkunde'),'one customer: the default customer is not named');
// ---- the console frame (ui/shell/page-frame.ts): its header once at the top, while loading and with the table ----
{
 let calls=0;const frame={header:primary=>{calls++;return React.createElement('header',{className:'test-frame-header'},primary);},refresh:0,tab:'',onTab(){}};
 for(const loading of [true,false]){
  calls=0;harness.reset();const framed=harness.html(AuditLogPage,{entries:[row(1)],loading,frame});
  ok(/^<header class="test-frame-header"><\/header><div class="sdx-settings-page">/.test(framed)&&calls===1,(loading?'loading':'loaded')+': the frame header once, before the SettingsPage');
 }
}

// ---- the empty state (also demo) ----
harness.reset();markup=harness.html(AuditLogPage,{entries:[]});
ok(text(markup).includes(de('audit.emptyTitle'))&&text(markup).includes(de('audit.emptyHint'))&&!/sdx-empty"><span[^>]*>.*<button/.test(markup),'the empty audit log: its title and sentence, no action');

// ---- Load older entries ----
harness.reset();markup=harness.html(AuditLogPage,{entries:first.slice(0,99)});
ok(!text(markup).includes(de('activity.loadOlder')),'below 100 rows: no button');
ok(text(markup).includes('25 von 99 Einträgen')||text(markup).includes('99 von 99 Einträgen'),'the plain foot below the limit');
const older=Array.from({length:100},(_,index)=>row(index+101));
const calls=[];
const load=answer=>before=>{calls.push(before);return answer();};
let props={entries:first,load:load(()=>Promise.resolve({audit:older}))};
harness.reset();let tree=harness.tree(AuditLogPage,props);markup=harness.html(AuditLogPage,props);
ok(text(markup).includes(de('activity.loadOlder'))&&text(markup).includes('100 der neuesten 100 Einträge'),'at 100 rows: the button and the newest foot');
// The page of the table stays when rows are appended.
let table=harness.find(tree,node=>node.props?.exportName==='audit-log');
check([table.props.limit,table.props.more,table.props.entranceId],[auditPageLimit,true,'audit-log'],'the table gets the limit, more and its entrance');
const button=()=>harness.find(harness.tree(AuditLogPage,props),node=>node.props?.exportName==='audit-log').props.footAction;
button().props.onClick();await harness.settle();
check(calls.map(entry=>`${entry.at}.${entry.id}`),[`${now-100000}.100`],'the cursor is <at>.<id> of the oldest loaded row');
tree=harness.tree(AuditLogPage,props);table=harness.find(tree,node=>node.props?.exportName==='audit-log');
check([table.props.entries.length,table.props.entries.at(-1).id,table.props.more],[200,200,true],'the next 100 rows are appended and more may exist');
// A short answer hides the button and the foot reads the plain count.
props={...props,load:load(()=>Promise.resolve({audit:[row(201)]}))};
harness.find(harness.tree(AuditLogPage,props),node=>node.props?.exportName==='audit-log').props.footAction.props.onClick();await harness.settle();
tree=harness.tree(AuditLogPage,props);table=harness.find(tree,node=>node.props?.exportName==='audit-log');
check([table.props.entries.length,table.props.more,table.props.footAction],[201,false,null],'a short answer: no more button');
// A failure keeps the rows and says why.
harness.reset();props={entries:first,load:load(()=>Promise.reject(new Error('Die Verbindung ist unterbrochen.')))};
harness.tree(AuditLogPage,props);
harness.find(harness.tree(AuditLogPage,props),node=>node.props?.exportName==='audit-log').props.footAction.props.onClick();await harness.settle();
tree=harness.tree(AuditLogPage,props);table=harness.find(tree,node=>node.props?.exportName==='audit-log');
check([table.props.entries.length,harness.toasts],[100,['error:Die Verbindung ist unterbrochen.']],'a failure: a toast, the rows stay');
// A console refresh replaces the rows with the newest 100.
harness.reset();props={entries:first,load:load(()=>Promise.resolve({audit:older}))};
harness.tree(AuditLogPage,props);
harness.find(harness.tree(AuditLogPage,props),node=>node.props?.exportName==='audit-log').props.footAction.props.onClick();await harness.settle();
const refreshed=first.map(entry=>({...entry}));
tree=harness.tree(AuditLogPage,{...props,entries:refreshed});table=harness.find(tree,node=>node.props?.exportName==='audit-log');
check(table.props.entries.length,100,'a refresh: the newest 100 again');
// The default read: GET /api/console?audit=portal&before=<at>.<id>.
harness.reset();props={entries:first};
harness.tree(AuditLogPage,props);
harness.find(harness.tree(AuditLogPage,props),node=>node.props?.exportName==='audit-log').props.footAction.props.onClick();await harness.settle();
check(requests,[`/api/console?audit=portal&before=${now-100000}.100`],'the request URL carries the cursor');
// The loading button.
harness.reset();props={entries:first,load:()=>new Promise(()=>{})};
harness.tree(AuditLogPage,props);
harness.find(harness.tree(AuditLogPage,props),node=>node.props?.exportName==='audit-log').props.footAction.props.onClick();
check(harness.find(harness.tree(AuditLogPage,props),node=>node.props?.exportName==='audit-log').props.footAction.props.loading,true,'the button loads while the request runs');

console.log(`PASS audit log view (${checks} checks): the SettingsPage with the full-width ActivityTable, the Skeleton, the Area column with deleted customers, the empty state and "Load older entries" with cursor, append, failure, short answer and refresh.`);
