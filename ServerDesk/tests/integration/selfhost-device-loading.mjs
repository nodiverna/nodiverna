// Loading states of the device views with deferred requests: initial load, empty and refresh, late responses,
// authorization loss and run output (pnpm test:selfhost).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as consoleRoute from '../../lib/console-route.ts';
import {accessCapabilities} from '../support/access-capabilities.mjs';
import {de,i18nRequire} from '../support/i18n-stubs.mjs';
const overviewFixture={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('ui/devices/device/device-overview.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>i18nRequire(id)??{},overviewFixture,overviewFixture.exports);
const {deviceOverviewGpus}=overviewFixture.exports;

// Exercise real component callbacks and effects with deferred requests. The
// transport deliberately ignores abort, as a response may already be in flight.
function harness(file,props){
 const cells=[],pending=[],timers=new Map();let index=0,dirty=false,tree,nextTimer=0;
 const same=(a,b)=>a?.length===b?.length&&a.every((item,i)=>Object.is(item,b[i]));
 const hooks={
  useState(initial){const at=index++;if(!cells[at])cells[at]={value:typeof initial==='function'?initial():initial};return [cells[at].value,value=>{const next=typeof value==='function'?value(cells[at].value):value;if(!Object.is(next,cells[at].value)){cells[at].value=next;dirty=true;}}];},
  useRef(initial){const at=index++;if(!cells[at])cells[at]={current:initial};return cells[at];},
  useCallback(callback,deps){const at=index++;if(!cells[at]||!same(cells[at].deps,deps))cells[at]={deps,value:callback};return cells[at].value;},
  useEffect(callback,deps){const at=index++;if(!cells[at]||!same(cells[at].deps,deps)){const previous=cells[at];cells[at]={deps,callback,cleanup:previous?.cleanup,changed:true};}},
  useId(){return 'panel';},
 };
 hooks.useLayoutEffect=hooks.useEffect;
 class ApiError extends Error{constructor(status){super('Request denied');this.status=status;}}
 const shared={ApiError,api:(url,body,signal)=>new Promise((resolve,reject)=>pending.push({url,body,signal,resolve,reject})),message:error=>error.message,stamp:String,permitted:()=>true,v3:()=>true};
 // The real reason helper (pure).
 const unavailable={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync('ui/devices/device/device-unavailable.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(()=>({}),unavailable,unavailable.exports);
 const component=new Proxy({__esModule:true,default:'LoadingSkeleton'},{get:(object,key)=>key in object?object[key]:String(key)});
 const jsx=(type,props,key)=>({type,props:props??{},key});
 // The real pure catalog owner helpers (library and customer entries).
 const catalogOwner={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync('ui/base/catalog-owner.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(id=>i18nRequire(id)??{defaultCustomerId:'00000000-0000-4000-8000-000000000100'},catalogOwner,catalogOwner.exports);
 // The real pure cross-customer helpers.
 const crossCustomerRight={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync('lib/cross-customer-right.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(()=>({}),crossCustomerRight,crossCustomerRight.exports);
 const crossCustomer={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync('ui/base/cross-customer.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(id=>i18nRequire(id)??(id==='@/lib/cross-customer-right'?crossCustomerRight.exports:{}),crossCustomer,crossCustomer.exports);
 // The language hooks and i18n modules (German, the default language) and the
 // result resolver: stored text, as for an older agent.
 const localRequire=id=>i18nRequire(id)??(id==='@/ui/base/access-capabilities'?accessCapabilities:id==='@/lib/agent-messages'?{agentMessageText:job=>job.result}:id==='@/ui/base/catalog-owner'?catalogOwner.exports:id==='@/ui/base/cross-customer'?crossCustomer.exports:id==='@/ui/kit/tabs'?{Tabs:'Tabs',tabId:(base,id)=>base+'-tab-'+id}:id==='@/ui/devices/device/device-unavailable'?unavailable.exports:id==='sonner'?{toast:{success(){},error(){}}}:id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='@/ui/base/api'?shared:id==='@/ui/base/ui-device'?{deviceConnection:()=>({kind:'online'})}:id==='@/lib/rdp-feature'?{REMOTE_DESKTOP_AVAILABLE:false,REMOTE_DESKTOP_STATUS:'In Arbeit'}:id==='@/lib/console-route'?consoleRoute:id==='@/ui/devices/device/device-overview'?{default:id,deviceOverviewGpus,__esModule:true}:id==='./loading-skeleton'?component:new Proxy({__esModule:true,default:id},{get:(object,key)=>key in object?object[key]:String(key)}));
 const compiled={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 new Function('require','module','exports','setInterval','clearInterval',code)(localRequire,compiled,compiled.exports,callback=>{const id=++nextTimer;timers.set(id,callback);return id;},id=>timers.delete(id));
 function render(runEffects=true){let turns=0;do{dirty=false;index=0;tree=compiled.exports.default(props);if(runEffects){for(const cell of cells){if(!cell.changed)continue;cell.changed=false;cell.cleanup?.();cell.cleanup=cell.callback();}}assert.ok(++turns<20,'component settles');}while(dirty);return tree;}
 // Kit parts are string types here: walk their children, their element props and, for a DataTable, the
 // cells of every row (or its empty state).
 const parts=node=>[node.props?.children,node.props?.primary,node.props?.actions,node.props?.footer,node.props?.action,...(node.type==='DataTable'?node.props.rows.length?node.props.rows.flatMap(row=>node.props.columns.map(column=>column.cell(row))):[node.props.empty?.title,node.props.empty?.children]:[])];
 const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...parts(node).flat(Infinity).flatMap(nodes)];
 const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):Array.isArray(node)?node.map(text).join(''):parts(node).map(text).join('');
 const find=predicate=>nodes(tree).find(predicate);
 const button=label=>find(node=>node.type==='IconBtn'?node.props.label===label:node.type==='button'||node.type==='Btn'?text(node)===label:false);
 const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));render();};
 const dispose=()=>{for(const cell of cells)cell.cleanup?.();};
 return {props,pending,render,settle,dispose,find,findAll:predicate=>nodes(tree).filter(predicate),button,text:()=>text(tree),skeleton:()=>find(node=>node.type==='Skeleton'),ApiError};
}
// A pattern that matches a catalog text literally.
const literal=text=>new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
const viewer={id:'owner',permissions:['*']},device=id=>({id,name:id,revoked:0,permissions:[],management:1,lastSeen:Date.now(),snapshot:{protocolVersion:3}});
const data=(name,runs=[])=>({runbooks:name?[{id:name,name,canManage:true,canDelete:true,versions:[]}]:[],runs,schedules:[]});

test('runbooks distinguish initial loading, resolved empty and refresh with saved data',async()=>{
 const ui=harness('ui/automation/runbook-panel.tsx',{servers:[device('a')],viewer,demo:false,serverId:'a'});
 ui.render(false);assert.equal(ui.skeleton().props.variant,'table');assert.doesNotMatch(ui.text(),literal(de('runbooks.none')));
 ui.render();ui.pending[0].resolve(data('Saved runbook'));await ui.settle();assert.match(ui.text(),/Saved runbook/);assert.equal(ui.skeleton(),undefined);
 ui.button(de('network.refresh')).props.onClick();ui.render();assert.match(ui.text(),/Saved runbook/,'refresh retains existing data');assert.equal(ui.skeleton(),undefined);
 ui.pending[1].resolve(data(null));await ui.settle();assert.match(ui.text(),literal(de('runbooks.none')));assert.equal(ui.skeleton(),undefined);ui.dispose();
});

test('a late previous-device response and error cannot replace the new device view',async()=>{
 const ui=harness('ui/automation/runbook-panel.tsx',{servers:[device('a'),device('b')],viewer,demo:false,serverId:'a'});
 ui.render();const old=ui.pending[0];ui.props.serverId='b';ui.render();assert.equal(old.signal.aborted,true);const current=ui.pending[1];
 current.resolve(data('Device B'));await ui.settle();old.resolve(data('PRIVATE DEVICE A'));await ui.settle();assert.match(ui.text(),/Device B/);assert.doesNotMatch(ui.text(),/PRIVATE DEVICE A/);
 ui.button(de('network.refresh')).props.onClick();ui.render();const failed=ui.pending[2];ui.button(de('network.refresh')).props.onClick();ui.render();ui.pending[3].resolve(data('Newest B'));await ui.settle();failed.reject(new ui.ApiError(403));await ui.settle();assert.match(ui.text(),/Newest B/);assert.equal(ui.find(node=>node.type==='Notice'&&node.props.tone==='danger'),undefined,'a stale failure shows no error');ui.dispose();
});

test('latest refresh wins and authorization loss removes old data',async()=>{
 const ui=harness('ui/automation/runbook-panel.tsx',{servers:[device('a')],viewer,demo:false,serverId:'a'});
 ui.render();ui.pending[0].resolve(data('Existing'));await ui.settle();
 ui.button(de('network.refresh')).props.onClick();ui.render();const first=ui.pending[1];ui.button(de('network.refresh')).props.onClick();ui.render();ui.pending[2].resolve(data('New'));await ui.settle();first.resolve(data('Old'));await ui.settle();assert.match(ui.text(),/New/);assert.doesNotMatch(ui.text(),/Old/);
 ui.button(de('network.refresh')).props.onClick();ui.render();ui.pending[3].reject(new ui.ApiError(403));await ui.settle();assert.doesNotMatch(ui.text(),/New/);assert.equal(ui.skeleton(),undefined,'failed initial view shows its error, not endless loading');ui.dispose();
});

test('run output waits for details and late details cannot overwrite a new selection',async()=>{
 const runs=['run-a','run-b'].map(id=>({id,versionId:id,state:'succeeded',createdAt:1,devices:[{serverId:'a',state:'succeeded',stepIndex:0,steps:[{stepIndex:0,jobId:id,state:'succeeded',createdAt:1}]}]}));
 const ui=harness('ui/automation/runbook-panel.tsx',{servers:[device('a')],viewer,demo:false,serverId:'a',initialTab:'runs'});
 ui.render();ui.pending[0].resolve(data(null,runs));await ui.settle();
 const output=menu=>menu.props.entries.find(entry=>entry.id==='output');
 output(ui.find(node=>node.type==='Menu')).onSelect();ui.render();const old=ui.pending[1];assert.equal(ui.skeleton().props.variant,'facts');assert.doesNotMatch(ui.text(),literal(de('runbooks.noOutput')));
 const runMenus=ui.findAll(node=>node.type==='Menu'&&output(node));assert.equal(runMenus.length,2,'run list remains available while details load');
 output(runMenus[1]).onSelect();ui.render();assert.equal(old.signal.aborted,true);
 const detail=(run,output)=>({...run,devices:run.devices.map(device=>({...device,steps:device.steps.map(step=>({...step,output:{output,stderr:'',exitCode:0,truncated:false}}))}))});
 ui.pending[2].resolve(data(null,[detail(runs[1],'CURRENT B OUTPUT')]));await ui.settle();assert.match(ui.text(),/CURRENT B OUTPUT/);
 old.resolve(data(null,[detail(runs[0],'PRIVATE LATE OUTPUT')]));await ui.settle();assert.match(ui.text(),/CURRENT B OUTPUT/);assert.doesNotMatch(ui.text(),/PRIVATE LATE OUTPUT/);ui.dispose();
});
