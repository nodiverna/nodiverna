// The read side of Configuration drift (ui/automation/drift-overview.tsx) rendered with React SSR in German:
// the current-state card with its state pill and "Accept as baseline" (blocked with the concrete
// reason), the changes since the baseline and the history as DataTables whose rows open the
// details, the cause-specific empty states and the policy disclosure below the history.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {de} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),cache=new Map(),root=process.cwd();
function load(filename){
 const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;
 if(absolute.endsWith('.css'))return {};
 const source=fs.readFileSync(absolute,'utf8'),mod={exports:{}};cache.set(absolute,mod);
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}return require(id);}
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const {DriftOverview,driftAcceptReason}=load(path.join(root,'ui/automation/drift-overview.tsx'));
let checks=0;const ok=(value,label)=>{assert.ok(value,label);checks++;};const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const at=Date.now(),noop=()=>{},props={busy:false,canManage:true,historyDays:7,now:at,onHistoryDays:noop,onEdit:noop,onInspect:noop,onAccept:noop};
const baseline={id:'baseline',reportId:'baseline-report',policyVersion:1,createdAt:at-3600000,createdBy:'private:owner@test'},current={id:'current',policyVersion:1,scannedAt:at,receivedAt:at,firstScannedAt:at-1800000,scanCount:301,complete:true,state:'in_sync',changes:[],errors:[]};
const data={state:'in_sync',baseline,baselines:[baseline],current,history:[],retentionDays:30,historyLimit:200,policy:{enabled:true,version:1}};
const render=state=>renderToStaticMarkup(React.createElement(DriftOverview,{...props,...state}));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&quot;/g,'"').replace(/\s+/g,' ');
// The kit Btn with this label: its markup, so tests read aria-disabled and the description.
const btn=(html,label)=>html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*<span>${label}</span>(?:(?!</button>).)*</button>`))?.[0]??'';
const blockedWith=(html,label,reason)=>{const markup=btn(html,label);return /aria-disabled="true"/.test(markup)&&markup.includes(`>${reason}</span>`)&&!/ disabled=""/.test(markup);};

// ---- In sync: the changes card says so, the baseline scan opens, accepting again is blocked ----
let html=render({data});
ok(text(html).includes(de('drift.currentState'))&&html.includes(`<span class="sdx-pill sdx-pill-success"><i aria-hidden="true"></i>${de('drift.state.inSync')}</span>`),'the current-state card with the state as a success pill');
ok(text(html).includes(de('drift.noChanges'))&&text(html).includes(de('drift.noChangesHint')),'no changes: Empty with a sentence');
ok(text(html).includes('Quellscan ansehen'),'the baseline source scan can be opened');
ok(blockedWith(html,'Aktuellen Stand als Baseline übernehmen',de('drift.blocked.alreadyBaseline')),'a healthy scan cannot become the baseline again, and says why');
ok(!text(html).includes('Bestätigen'),'no generic confirm label');

// ---- Drifted: the change rows open their diff; the history merges scans ----
const change={key:'file:app',kind:'file',path:'C:\\Config\\app.config',change:'modified'},drift={...data,state:'drifted',current:{...current,state:'drifted',changes:[change]},history:[{...current,kind:'change',changeCount:1,errorCount:0}]};
html=render({data:drift});
ok(/role="region" aria-label="Änderungen seit der Baseline"/.test(html),'the changes are a labelled DataTable region');
ok(html.includes('C:\\Config\\app.config')&&/<tr class="sdx-row-clickable"><td[^>]*><button type="button" class="sdx-row-open">/.test(html),'a change row opens its diff');
ok(!text(html).includes('Diff ansehen')&&!/<td[^>]*><button[^>]*sdx-btn/.test(html),'no per-row "View diff" buttons');
ok(text(html).includes('301 Scans zusammengefasst'),'the history row merges identical scans');
ok(/role="region" aria-label="Verlauf"/.test(html),'the history is a labelled DataTable region');
const acceptMarkup=btn(html,'Aktuellen Stand als Baseline übernehmen');
ok(acceptMarkup&&!/aria-disabled/.test(acceptMarkup)&&/sdx-btn-primary/.test(acceptMarkup),'a drifted complete scan can be accepted (primary)');
let accepted=null;const opened=[];
// The row and history open handlers: called through the element props of the rendered tables.
const walk=(node,found=[])=>{if(Array.isArray(node)){node.forEach(child=>walk(child,found));return found;}if(!node||typeof node!=='object'||!node.props)return found;found.push(node);for(const value of Object.values(node.props))if(value&&typeof value==='object')walk(value,found);return found;};
// The element tree of one render (hooks need a render), to call the handlers the tables and buttons get.
let element=null;renderToStaticMarkup(React.createElement(()=>{element=DriftOverview({...props,data:drift,onInspect:(...args)=>opened.push(args),onAccept:report=>{accepted=report;}});return null;}));
const tables=walk(element).filter(node=>Array.isArray(node.props.columns));
tables[0].props.onOpen(tables[0].props.rows[0]);tables[1].props.onOpen(tables[1].props.rows[0]);
check(opened,[['current',0],['current',0,true]],'a change row opens its diff; a history row opens the scan');
walk(element).find(node=>node.props.blocked===undefined&&node.props.variant==='primary'&&node.props.onClick).props.onClick();
check(accepted?.id,'current','the accept button hands the current scan to the confirmation');
check(walk(element).filter(node=>Array.isArray(node.props.columns)).map(table=>table.props.label),['Änderungen seit der Baseline','Verlauf'],'changes first, then the history');

// ---- Reasons: right, incomplete, outdated, busy ----
html=render({data:drift,canManage:false});
ok(blockedWith(html,'Aktuellen Stand als Baseline übernehmen',de('drift.blocked.manage')),'readers see the button blocked with the right');
const incomplete={...drift,state:'error',current:{...drift.current,state:'error',complete:false,errors:['File locked']}};
html=render({data:incomplete});
ok(text(html).includes('File locked')&&/sdx-notice-danger/.test(html),'scan errors show in a danger notice');
ok(text(html).includes('Unvollständiger Scan'),'the incomplete scan is named');
ok(blockedWith(html,'Aktuellen Stand als Baseline übernehmen',de('drift.blocked.incomplete')),'an incomplete scan is blocked with its reason');
const t=(key,params)=>de(key,params);
check(driftAcceptReason({...drift.current,receivedAt:at-90000000,scannedAt:at-90000000},drift,true,false,at,t),de('drift.blocked.outdated'),'older than 24 h');
check(driftAcceptReason({...drift.current,policyVersion:0},drift,true,false,at,t),de('drift.blocked.outdated'),'another policy version');
check(driftAcceptReason(drift.current,drift,true,true,at,t),de('automation.busy'),'a running change');
check(driftAcceptReason(drift.current,drift,true,false,at,t),null,'a fresh complete drifted scan');
check(driftAcceptReason({...drift.current,id:'baseline-report'},drift,true,false,at,t),de('drift.blocked.alreadyBaseline'),'the baseline scan itself');

// ---- Baseline missing, not set up, first scan pending, empty history ----
html=render({data:{...data,state:'baseline_missing',baseline:null,baselines:[],current:{...current,state:'baseline_missing',changes:[change]}}});
ok(text(html).includes('Erste Baseline übernehmen')&&text(html).includes('Noch keine Referenz'),'the first baseline');
html=render({data:{...data,state:'disabled',current:null,baseline:null,baselines:[],policy:{enabled:false,version:undefined}}});
ok(text(html).includes(de('drift.setupMonitoring'))&&text(html).includes(de('drift.chooseItems'))&&text(html).includes(de('drift.setupPolicy')),'not set up: Empty with the policy action');
html=render({data:{...data,state:'disabled',current:null,baseline:null,baselines:[],policy:{enabled:false,version:undefined}},canManage:false});
ok(text(html).includes(de('drift.setupMonitoring'))&&!text(html).includes(de('drift.setupPolicy')),'readers get no policy action in the empty state');
html=render({data:{...data,state:'loading',current:null,policy:{enabled:true,version:1}}});
ok(text(html).includes(de('drift.firstScanPending'))&&text(html).includes(de('drift.agentReportsFirst')),'first scan pending');
html=render({data:{...data,baselines:[]}});
ok(text(html).includes(de('drift.noEvents'))&&text(html).includes(de('drift.noEventsHint')),'no events: Empty with a sentence');
ok(/<select class="sdx-select sdx-select-sm"[^>]*>/.test(html)&&text(html).includes(de('device.summary.range')),'the range select sits in the history toolbar');
html=render({data,children:React.createElement('details',{className:'policy-fixture'},React.createElement('summary',null,'Drift-Richtlinie'))});
ok(html.indexOf('aria-label="Verlauf"')<html.indexOf('policy-fixture'),'the policy disclosure follows the history at the bottom');
console.log(`PASS drift view (${checks} checks): the current-state card with the state pill and the blocked or open "Accept as baseline", change and history rows that open the details, the cause-specific empty states and the policy below the history.`);
