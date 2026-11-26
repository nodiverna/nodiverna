// The fleet agent updates (ui/devices/fleet/fleet-agent-updates.tsx) on hand-written hooks: loading, the confirmation,
// MFA retry, limits, the cross-customer lock and the changelog; the version cell's update action as the kit Btn
// (rendered with the real kit by SSR) and its CSS.
// The shared loader resolves the extensionless imports of the helper (ui/base/access-capabilities).
import '../../support/register.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
import {accessCapabilities} from '../../support/access-capabilities.mjs';
// The connection rule of the clock key (agentUpdateClockState).
const deviceConnection=await import('../../../lib/device-connection.ts');
const state=await import('../../../lib/agent-update-state.ts');
const updateModel=await import('../../../ui/devices/device/agent-update-model.ts');
const deviceState=await import('../../../ui/base/ui-device.ts');
const helper={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('ui/devices/fleet/fleet-agent-update-state.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(id=>i18nRequire(id)??(id==='@/lib/agent-update-state'?state:id==='@/ui/devices/device/agent-update-model'?updateModel:id==='@/ui/base/ui-device'?deviceState:(()=>{throw Error('Unexpected '+id);})()),helper,helper.exports);
const fleetState=helper.exports;
// The real pure helpers for cross-customer selections.
const transpiled=(file,require)=>{const mod={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(id=>i18nRequire(id)??require(id),mod,mod.exports);return mod.exports;};
const crossCustomerRight=transpiled('lib/cross-customer-right.ts',id=>{throw Error('Unexpected '+id);});
const crossCustomer=transpiled('ui/base/cross-customer.ts',id=>id==='@/lib/cross-customer-right'?crossCustomerRight:(()=>{throw Error('Unexpected '+id);})());
// The shared step-up retry (imports nothing) runs as it is.
// The imports of the step-up hook (useStepUp, unused here) get empty stubs.
const hookStubs={'react':{},'sonner':{toast:{error(){}}},'@/ui/base/api':{message:String}};
const stepUpRetry=transpiled('ui/session/step-up-retry.ts',id=>{if(Object.hasOwn(hookStubs,id))return hookStubs[id];throw Error('Unexpected '+id);});

const now=Date.now(),sha='a'.repeat(64);let checks=0;
function release(version='4.6.0'){return {id:`release-${version}`,version,active:true,sha256:sha,size:100,createdAt:now,signature:'signature',changelog:{features:['Geräteinventar verbessert'],fixes:['Verbindungsabbruch behoben']},manifest:{version,sha256:sha,size:100,protocolVersion:3,minProtocolVersion:3,os:['Windows 11 Pro'],arch:'x64',path:'/downloads/agent.zip',layout:'single-exe',exe:{path:'/downloads/agent.exe',sha256:sha,size:200}}};}
function device(id='device-a',extra={}){return {id,name:id.toUpperCase(),management:1,lastSeen:now,permissions:['update'],snapshot:{agentVersion:'4.3.0',os:'Microsoft Windows 11 Pro',protocolVersion:3,mode:'Management',agentCapabilities:['agent-update','release-paths']},...extra};}
function harness({servers=[device()],get,post}={}){
 const cells=[],effects=[],layoutEffects=[],calls=[],intervals=new Map(),timers=new Map();let cursor=0,dirty=false,tree,timerId=0,refreshes=0,previousScoped;
 const props={servers,viewer:{id:'operator',permissions:[]},demo:false,jobs:[],now,onUpdated:()=>{refreshes++;},children:'Fleet'};
 const hooks={createContext(){return {Provider:'Provider'};},useContext(){return tree.props.value;},useState(initial){const index=cursor++;cells[index]??={value:initial};return[cells[index].value,value=>{const next=typeof value==='function'?value(cells[index].value):value;if(!Object.is(next,cells[index].value)){cells[index].value=next;dirty=true;}}];},useRef(initial){const index=cursor++;cells[index]??={value:{current:initial}};return cells[index].value;},useCallback(fn,deps){const index=cursor++,old=cells[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))cells[index]={deps,value:fn};return cells[index].value;},useEffect(fn,deps){const index=cursor++,old=cells[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))effects.push(()=>{old?.cleanup?.();cells[index]={deps,cleanup:fn()};});},useLayoutEffect(fn,deps){const index=cursor++,old=cells[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))layoutEffects.push(()=>{old?.cleanup?.();cells[index]={deps,cleanup:fn()};});}};
 class ApiError extends Error{constructor(text,status,code){super(text);this.status=status;this.code=code;}}
 const jsx=(type,props,key)=>({type,props:props??{},key}),mod={exports:{}};
 const api=async(url,payload,signal)=>{calls.push({url,payload,signal});return payload?(post?post(payload,signal,ApiError):{jobs:payload.serverIds.map(id=>'job-'+id),scheduledAt:now}):(get?get(signal,ApiError):{releases:[release()],campaigns:[]});};
 const require=id=>i18nRequire(id)??(id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({}, {get:(_object,key)=>String(key)}):id==='@/ui/kit/kit'?{Btn:'Btn',Drawer:'Drawer',Empty:'Empty',IconBtn:'IconBtn',Notice:'Notice',Skeleton:'Skeleton'}:id==='@/ui/kit/confirm-dialog'?{ConfirmDialog:'ConfirmDialog'}:id==='@/lib/agent-update-state'?state:id==='@/ui/devices/device/agent-update-model'?updateModel:id==='@/ui/devices/fleet/fleet-agent-update-state'?fleetState:id==='@/ui/base/access-capabilities'?accessCapabilities:id==='@/ui/base/api'?{api,ApiError,message:error=>error.message,stamp:value=>String(value)}:id==='@/ui/session/mfa-step-up'?{MfaStepUp:'MfaStepUp'}:id==='@/ui/base/cross-customer'?crossCustomer:id==='@/ui/base/clock-store'?{useClockNow:pinned=>pinned??Date.now()}:id==='@/lib/device-connection'?deviceConnection:id==='@/ui/session/step-up-retry'?stepUpRetry:id.endsWith('.css')?{}:(()=>{throw Error('Unexpected '+id);})());
 const code=ts.transpileModule(fs.readFileSync('ui/devices/fleet/fleet-agent-updates.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 new Function('require','module','exports','setInterval','clearInterval','setTimeout','clearTimeout',code)(require,mod,mod.exports,(fn,ms)=>{const id=++timerId;intervals.set(id,{fn,ms});return id;},id=>intervals.delete(id),(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},id=>timers.delete(id));
 function nodes(node){if(arguments.length===0)node=tree;if(!node||typeof node!=='object')return[];return[node,...[node.props?.children,node.props?.actions,node.props?.footer].flat(Infinity).flatMap(child=>nodes(child))];}
 const text=node=>[node?.props?.children].flat(Infinity).map(child=>typeof child==='string'||typeof child==='number'?child:child&&typeof child==='object'?text(child):'').join('');
 const find=predicate=>nodes().find(predicate),button=label=>find(node=>node.type==='Btn'&&text(node).includes(label));
 function render(){let limit=0;do{dirty=false;cursor=0;const scoped=mod.exports.FleetAgentUpdates(props);if(previousScoped){assert.equal(scoped.type,previousScoped.type,'fleet controller component stays mounted when filters change');assert.equal(scoped.key,previousScoped.key,'fleet children must not receive a changing scope key');}previousScoped=scoped;tree=scoped.type(scoped.props);for(const effect of layoutEffects.splice(0))effect();for(const effect of effects.splice(0))effect();if(limit++>8)throw Error('Unstable render');}while(dirty);}
 async function settle(predicate=()=>!tree.props.value.loading){for(let n=0;n<60;n++){await new Promise(resolve=>setImmediate(resolve));if(dirty)render();if(predicate())return;}throw Error('State did not settle');}
 const open=id=>{tree.props.value.open(id);render();};
 const prepare=()=>{button('Updates prüfen').props.onClick();render();};
 const confirm=()=>{find(node=>node.type==='ConfirmDialog').props.onConfirm();render();};
 function unmount(){for(const cell of cells)cell?.cleanup?.();}
 render();return {props,calls,intervals,render,settle,find,button,nodes,open,prepare,confirm,unmount,row:()=>mod.exports.FleetAgentUpdateCell({server:props.servers[0]}),text:()=>nodes().map(text).join(' '),get refreshes(){return refreshes;},get context(){return tree.props.value;}};
}

let resolveCatalog,ui=harness({get:()=>new Promise(resolve=>{resolveCatalog=resolve;})});assert.equal(ui.context.loading,true);assert.equal(ui.context.rows[0].update,null);checks+=2;await Promise.resolve();resolveCatalog({releases:[release()],campaigns:[]});await ui.settle();assert.equal(ui.context.rows[0].update.version,'4.6.0');assert.equal(ui.calls.length,1);checks+=2;ui.open('device-a');ui.prepare();assert.deepEqual(ui.find(node=>node.type==='ConfirmDialog').props.lines,[{label:'DEVICE-A',value:'4.3.0 → 4.6.0',mono:true}],'the targets are the Facts lines of the ConfirmDialog');assert.equal(ui.calls.filter(call=>call.payload).length,0);checks+=2;ui.unmount();

let resolveDeploy;ui=harness({post:payload=>new Promise(resolve=>{resolveDeploy=()=>resolve({jobs:payload.serverIds.map(id=>'job-'+id),scheduledAt:now});})});await ui.settle();ui.open('device-a');ui.prepare();ui.confirm();ui.confirm();assert.equal(ui.calls.filter(call=>call.payload).length,1);assert.deepEqual(ui.calls.find(call=>call.payload).payload,{action:'deploy',releaseId:'release-4.6.0',serverIds:['device-a'],confirm:true});checks+=2;resolveDeploy();await ui.settle(()=>ui.context.rows[0].state?.phase==='queued');assert.match(ui.text(),/Update angefordert/);assert.equal(ui.refreshes,1);checks+=2;ui.props.jobs=[{id:'job-device-a',serverId:'device-a',action:'agent-update',target:'4.6.0',state:'succeeded',createdAt:now}];ui.render();assert.equal(ui.context.rows[0].state.phase,'waiting');ui.props.servers=[{...ui.props.servers[0],snapshot:{...ui.props.servers[0].snapshot,agentVersion:'4.6.0'}}];ui.render();assert.equal(ui.context.rows[0].state.phase,'verified');checks+=2;ui.unmount();

let needsMfa=true;ui=harness({post:(_payload,_signal,ApiError)=>{if(needsMfa)throw new ApiError('MFA erforderlich.',403,'MFA_STEP_UP_REQUIRED');return {jobs:['job-device-a'],scheduledAt:now};}});await ui.settle();ui.open('device-a');ui.prepare();ui.confirm();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp').props.open);assert.equal(ui.calls.filter(call=>call.payload).length,1);checks++;needsMfa=false;ui.find(node=>node.type==='MfaStepUp').props.onVerified({managementToken:'proof-1'});ui.render();await ui.settle(()=>ui.context.rows[0].state?.phase==='queued');assert.equal(ui.calls.filter(call=>call.payload).length,2);assert.deepEqual(ui.calls.filter(call=>call.payload)[1].payload,ui.calls.filter(call=>call.payload)[0].payload,'the resent deploy relies on the renewed MFA session and carries no managementToken');assert.equal('managementToken' in ui.calls.filter(call=>call.payload)[0].payload,false);checks+=3;ui.unmount();

// A verification without a managementToken resends the remaining targets once as well.
needsMfa=true;ui=harness({post:(_payload,_signal,ApiError)=>{if(needsMfa)throw new ApiError('Melde dich mit MFA an, um fortzufahren.',403,'MFA_LOGIN_REQUIRED');return {jobs:['job-device-a'],scheduledAt:now};}});await ui.settle();ui.open('device-a');ui.prepare();ui.confirm();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp').props.open);
needsMfa=false;ui.find(node=>node.type==='MfaStepUp').props.onVerified({});ui.render();await ui.settle(()=>ui.context.rows[0].state?.phase==='queued');assert.equal(ui.calls.filter(call=>call.payload).length,2,'a verification without token resends once');assert.equal(ui.find(node=>node.type==='MfaStepUp').props.open,false);checks+=2;ui.unmount();

ui=harness({servers:Array.from({length:23},(_value,index)=>device('device-'+index))});await ui.settle();assert.equal(ui.calls.length,1,'one shared catalog fetch for the whole fleet');ui.open();ui.button('Bis zu 20 auswählen').props.onClick();ui.render();assert.equal(ui.nodes().filter(node=>node.type==='input'&&node.props.checked).length,20);assert.equal(ui.nodes().filter(node=>node.type==='input'&&!node.props.checked).every(node=>node.props.disabled),true);checks+=3;ui.prepare();ui.confirm();await ui.settle(()=>ui.context.rows.filter(row=>row.state?.phase==='queued').length===20);assert.equal(ui.calls.filter(call=>call.payload).length,1);assert.equal(ui.calls.find(call=>call.payload).payload.serverIds.length,20);checks+=2;ui.unmount();

ui=harness();await ui.settle();ui.open('device-a');ui.prepare();ui.props.servers=[{...ui.props.servers[0],lastSeen:now-300000}];ui.render();ui.confirm();await ui.settle(()=>ui.text().includes('nicht online'));assert.equal(ui.calls.filter(call=>call.payload).length,0,'preflight rechecks the current device after approval');checks++;ui.unmount();

ui=harness({get:()=>({releases:[{...release(),active:false}],campaigns:[]})});await ui.settle();assert.equal(ui.context.rows[0].update,null);ui.open();assert.equal(ui.button('Updates prüfen').props.blocked,'Wähle zwischen 1 und 20 verschiedene Geräte.');checks+=2;ui.unmount();

let secondNeedsMfa=true;const secondRelease=release('4.5.0');secondRelease.manifest.os=['Windows Server 2022'];
ui=harness({servers:[device(),device('device-b',{snapshot:{...device().snapshot,os:'Microsoft Windows Server 2022 Standard'}})],get:()=>({releases:[release(),secondRelease],campaigns:[]}),post:(payload,_signal,ApiError)=>{if(payload.releaseId===secondRelease.id&&secondNeedsMfa)throw new ApiError('MFA erforderlich.',403,'MFA_STEP_UP_REQUIRED');return {jobs:payload.serverIds.map(id=>'job-'+id),scheduledAt:now};}});await ui.settle();ui.open();ui.button('Bis zu 20 auswählen').props.onClick();ui.render();ui.prepare();ui.confirm();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp').props.open);assert.equal(ui.context.rows[0].state.phase,'queued');assert.deepEqual(ui.calls.filter(call=>call.payload).map(call=>call.payload.serverIds),[['device-a'],['device-b']]);checks+=2;secondNeedsMfa=false;ui.find(node=>node.type==='MfaStepUp').props.onVerified({managementToken:'proof-b'});ui.render();await ui.settle(()=>ui.context.rows.every(row=>row.state?.phase==='queued'));assert.deepEqual(ui.calls.filter(call=>call.payload).map(call=>call.payload.serverIds),[['device-a'],['device-b'],['device-b']],'successful bulk subset is never resent after step-up for the remaining release');assert.equal('managementToken' in ui.calls.filter(call=>call.payload).at(-1).payload,false);checks+=2;ui.unmount();

// A rollout relies on the MFA login session: one confirmation sends every
// release group in order, without a dialog and without a managementToken. When
// the session lapses during the loop, the dialog opens once; after it verifies,
// only the remaining targets go out, and later groups send without a dialog.
{
 const thirdRelease=release('4.4.0');thirdRelease.manifest.os=['Windows Server 2019'];
 const servers=()=>[device(),device('device-b',{snapshot:{...device().snapshot,os:'Microsoft Windows Server 2022 Standard'}}),device('device-c',{snapshot:{...device().snapshot,os:'Microsoft Windows Server 2019 Standard'}})];
 const catalog=()=>({releases:[release(),secondRelease,thirdRelease],campaigns:[]});
 const sent=()=>ui.calls.filter(call=>call.payload).map(call=>[call.payload.serverIds,'managementToken' in call.payload]);
 ui=harness({servers:servers(),get:catalog});
 await ui.settle();ui.open();ui.button('Bis zu 20 auswählen').props.onClick();ui.render();ui.prepare();ui.confirm();await ui.settle(()=>ui.context.rows.every(row=>row.state?.phase==='queued'));
 assert.deepEqual(sent(),[[['device-a'],false],[['device-b'],false],[['device-c'],false]],'one confirmation sends every release group in order, without a token');assert.equal(ui.find(node=>node.type==='MfaStepUp').props.open,false,'no MFA dialog on a live session');checks+=2;ui.unmount();
 let lapsed=true;
 ui=harness({servers:servers(),get:catalog,post:(payload,_signal,ApiError)=>{if(payload.releaseId===secondRelease.id&&lapsed){lapsed=false;throw new ApiError('Sitzung abgelaufen.',401,'SESSION_EXPIRED');}return {jobs:payload.serverIds.map(id=>'job-'+id),scheduledAt:now};}});
 await ui.settle();ui.open();ui.button('Bis zu 20 auswählen').props.onClick();ui.render();ui.prepare();ui.confirm();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp').props.open);
 assert.deepEqual(sent(),[[['device-a'],false],[['device-b'],false]],'the lapse on the second group stops the loop and opens the dialog');assert.equal(ui.context.rows[0].state.phase,'queued');checks+=2;
 ui.find(node=>node.type==='MfaStepUp').props.onVerified({managementToken:'proof-1'});ui.render();
 await ui.settle(()=>ui.context.rows.every(row=>row.state?.phase==='queued'));
 assert.deepEqual(sent(),[[['device-a'],false],[['device-b'],false],[['device-b'],false],[['device-c'],false]],'after the verification only the remaining targets go out, without a token; the third group asks for no second dialog');assert.equal(ui.find(node=>node.type==='MfaStepUp').props.open,false);checks+=2;ui.unmount();
}

needsMfa=true;ui=harness({post:(_payload,_signal,ApiError)=>{if(needsMfa)throw new ApiError('MFA erforderlich.',403,'MFA_STEP_UP_REQUIRED');return {jobs:['job-device-a'],scheduledAt:now};}});await ui.settle();ui.open('device-a');ui.prepare();ui.confirm();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp').props.open);ui.props.servers=[{...ui.props.servers[0],snapshot:{...ui.props.servers[0].snapshot,agentVersion:'4.6.0'}}];ui.render();needsMfa=false;ui.find(node=>node.type==='MfaStepUp').props.onVerified({managementToken:'proof-1'});ui.render();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp').props.open===false);assert.equal(ui.calls.filter(call=>call.payload).length,1,'MFA verification does not replay an update that is already installed');checks++;ui.unmount();

ui=harness();await ui.settle();ui.open('device-a');ui.prepare();ui.props.servers=[{...ui.props.servers[0],permissions:[]}];ui.render();assert.equal(ui.context.rows[0].inspect,false);assert.equal(ui.find(node=>node.type==='ConfirmDialog').props.open,false);assert.equal(ui.find(node=>node.type==='Drawer').props.open,false);checks+=3;ui.unmount();

ui=harness({post:(_payload,_signal,ApiError)=>{throw new ApiError('Remote-Desktop-Sitzung zuerst trennen.',409);}});await ui.settle();ui.open('device-a');ui.prepare();ui.confirm();await ui.settle(()=>ui.calls.length>=3&&!ui.context.busy);assert.match(ui.text(),/Remote-Desktop-Sitzung zuerst trennen/,'a successful catalog refresh does not erase the failed update reason');assert.equal(ui.context.rows[0].state,null);checks+=2;ui.unmount();

ui=harness({servers:[device('offline',{lastSeen:now-300000}),device('read-only',{management:0}),device('no-right',{permissions:[]})]});await ui.settle();assert.equal(ui.context.rows.every(row=>!row.eligible),true);ui.open('offline');assert.equal(ui.button('Updates prüfen').props.blocked,'Wähle zwischen 1 und 20 verschiedene Geräte.');checks+=2;ui.unmount();

let oldCatalog;ui=harness({get:()=>new Promise(resolve=>{oldCatalog=resolve;})});await Promise.resolve();ui.unmount();oldCatalog({releases:[release()],campaigns:[]});await new Promise(resolve=>setImmediate(resolve));assert.equal(ui.context.rows[0].update,null);checks++;
ui=harness();ui.unmount();await Promise.resolve();assert.equal(ui.calls.length,0,'disposing the mount before its initial load callback prevents a request');checks++;
// A selection over two customers needs the cross-customer right; the hint names the customers in the confirmation.
const lockText='Die Auswahl umfasst Geräte mehrerer Kunden. Dafür brauchst du die Berechtigung „Aktionen für mehrere Kunden starten“.',hintText='Das betrifft Geräte von 2 Kunden. Das Audit-Protokoll erhält für jeden Kunden einen eigenen Eintrag.';
ui=harness({servers:[device('a1',{customerId:'A'}),device('a2',{customerId:'A'}),device('b1',{customerId:'B'})]});await ui.settle();ui.open();ui.button('Bis zu 20 auswählen').props.onClick();ui.render();
assert.deepEqual([ui.button('Updates prüfen').props.blocked,ui.button('Updates prüfen').props.title],[lockText,undefined],'two customers without the right: locked with the reason');ui.button('Updates prüfen').props.onClick();ui.render();
assert.equal(ui.find(node=>node.type==='ConfirmDialog').props.open,false,'a locked selection opens no confirmation');checks+=2;
ui.props.viewer.permissions=['portal.msp.crossCustomer'];ui.render();
assert.deepEqual([ui.button('Updates prüfen').props.blocked,ui.button('Updates prüfen').props.title],[undefined,undefined],'with the right the selection is free');ui.prepare();
assert.equal(ui.find(node=>node.type==='ConfirmDialog').props.open,true);assert.match(ui.text(),new RegExp(hintText.replaceAll('.','\.')),'"Agent-Updates freigeben" shows the hint');checks+=3;
ui.confirm();await ui.settle(()=>ui.calls.some(call=>call.payload));assert.deepEqual(ui.calls.find(call=>call.payload).payload.serverIds,['a1','a2','b1']);checks++;ui.unmount();
ui=harness({servers:[device('a1',{customerId:'A'}),device('a2',{customerId:'A'}),device('demo')]});await ui.settle();ui.open();ui.button('Bis zu 20 auswählen').props.onClick();ui.render();
assert.deepEqual([ui.button('Updates prüfen').props.blocked,ui.button('Updates prüfen').props.title],[undefined,undefined],'one customer (and devices without customer) stay free');ui.prepare();
assert.doesNotMatch(ui.text(),/betrifft Geräte von/,'no hint for one customer');checks+=2;ui.unmount();
// The lock gives only the reason of the right: there is no edition mode before it.
const fleetSource=fs.readFileSync('ui/devices/fleet/fleet-agent-updates.tsx','utf8');
assert.deepEqual([/use-?[Ee]dition/.test(fleetSource),/crossCustomerLockReason\(viewer,targetCustomerCount\(servers,targets\.map\(target=>target\.serverId\)\),locale\)/.test(fleetSource)],[false,true],'the lock takes the viewer, the customers and the locale');checks++;
// One changelog per release group: it starts at the oldest installed agent of the selected targets.
{
 const textOf=node=>[node?.props?.children].flat(Infinity).map(child=>typeof child==='string'?child:child&&typeof child==='object'?textOf(child):'').join('');
 const changelogs=()=>ui.nodes().filter(node=>typeof node.type==='function'&&node.type.name==='Changelog').map(node=>node.type(node.props));
 const headings=tree=>[tree.props.children].flat(Infinity).find(child=>child?.type==='ol')?.props.children.map(item=>textOf(item.props.children[0]))??[];
 const history=[{version:'4.6.0',features:['Aus der History'],fixes:[]},{version:'4.5.1',features:[],fixes:['Behoben in 4.5.1']},{version:'4.4.0',features:['Neu in 4.4.0'],fixes:[]},{version:'4.3.0',features:['Schon installiert'],fixes:[]}];
 const agent=(id,agentVersion)=>device(id,{snapshot:{...device().snapshot,agentVersion}});
 ui=harness({servers:[agent('device-a','4.5.0'),agent('device-b','4.3.0')],get:()=>({releases:[release()],campaigns:[],history})});await ui.settle();ui.open();ui.button('Bis zu 20 auswählen').props.onClick();ui.render();
 let [mixed]=changelogs();
 assert.equal(changelogs().length,1,'one group for one release');
 assert.equal(textOf([mixed.props.children].flat(Infinity)[0]),'Änderungen von 4.3.0 bis 4.6.0');
 assert.match(textOf(mixed),/Die Liste beginnt beim ältesten ausgewählten Agent, 4\.3\.0\./);
 assert.deepEqual(headings(mixed),['Agent 4.6.0','Agent 4.5.1','Agent 4.4.0'],'from the oldest installed agent, newest first');
 assert.match(textOf(mixed),/Geräteinventar verbessert/,'the signed catalog changelog of the target wins');assert.ok(!textOf(mixed).includes('Aus der History')&&!textOf(mixed).includes('Schon installiert'));
 checks+=6;ui.unmount();
 // Equal installed versions: the same range without the oldest-agent line.
 ui=harness({servers:[agent('device-a','4.4.0'),agent('device-b','4.4.0')],get:()=>({releases:[release()],campaigns:[],history})});await ui.settle();ui.open();ui.button('Bis zu 20 auswählen').props.onClick();ui.render();
 [mixed]=changelogs();
 assert.equal(textOf([mixed.props.children].flat(Infinity)[0]),'Änderungen von 4.4.0 bis 4.6.0');assert.deepEqual(headings(mixed),['Agent 4.6.0','Agent 4.5.1']);assert.ok(!textOf(mixed).includes('Die Liste beginnt'));checks+=3;ui.unmount();
 // Without history the group shows the single-version changelog as before.
 ui=harness({servers:[agent('device-a','4.4.0')]});await ui.settle();ui.open('device-a');
 [mixed]=changelogs();
 assert.equal(textOf([mixed.props.children].flat(Infinity)[0]),'Änderungen in 4.6.0');assert.deepEqual(headings(mixed),[]);assert.match(textOf(mixed),/Verbindungsabbruch behoben/);checks+=3;ui.unmount();
}
// Kit parts: the Drawer footer holds the count and the primary, the ConfirmDialog names the verb, None is an Empty, checking a Skeleton.
{
 const source=fs.readFileSync('ui/devices/fleet/fleet-agent-updates.tsx','utf8');
 assert.doesNotMatch(source,/@\/components\/ui\/|DetailDrawer|className="notice|window\.confirm/,'no shadcn part, no DetailDrawer, no classic notice');checks++;
 let ui=harness();await ui.settle();ui.open('device-a');
 const drawer=ui.find(node=>node.type==='Drawer'),primary=ui.button('Updates prüfen');
 assert.equal(drawer.props.open,true);assert.equal(drawer.props.title,'Agent-Updates');assert.equal(primary.props.variant,'primary');assert.equal(primary.props.loading,false);
 assert.ok(ui.nodes(drawer.props.footer).includes(primary),'the primary sits in the drawer footer');assert.match(ui.nodes(drawer.props.footer).map(node=>[node.props?.children].flat().filter(child=>typeof child==='string').join('')).join(' '),/1 \/ 20 Geräte/,'the footer shows the selected count');
 assert.equal(ui.button('Bis zu 20 auswählen').props.variant,'ghost');assert.equal(ui.find(node=>node.type==='IconBtn').props.label,'Agent-Updates erneut prüfen');checks+=7;
 ui.prepare();const dialog=ui.find(node=>node.type==='ConfirmDialog');
 assert.deepEqual([dialog.props.title,dialog.props.confirmLabel,dialog.props.tone,dialog.props.body.startsWith('Diese Agents starten')],['Agent-Updates freigeben','Jetzt aktualisieren','default',true],'ConfirmDialog with the verb "Jetzt aktualisieren"');checks++;ui.unmount();
 let resolveList;ui=harness({get:()=>new Promise(resolve=>{resolveList=resolve;})});ui.open();
 assert.equal(ui.find(node=>node.type==='Skeleton').props.label,'Agent-Updates werden geprüft…','checking: the kit Skeleton with its label');checks++;
 await Promise.resolve();resolveList({releases:[],campaigns:[]});await ui.settle();ui.render();assert.equal(ui.find(node=>node.type==='Skeleton'),undefined);const empty=ui.find(node=>node.type==='Empty');
 assert.deepEqual([empty.props.title,empty.props.children],['Keine Agent-Updates verfügbar','Für diese Geräte ist gerade kein Agent-Update verfügbar. Ein Gerät wird nur angeboten, wenn eine neuere Version passt und du dafür die Wartungsberechtigung hast.'],'none: the kit Empty says the fact as its title and the reason as one sentence');
 const sayings=ui.nodes().flatMap(node=>[node.props?.children,node.props?.title,node.props?.blocked,node.props?.description].flat().filter(value=>typeof value==='string'&&value.includes('gerade kein Agent-Update')));
 assert.equal(sayings.length,1,'the long none sentence shows once in the drawer');
 assert.equal(ui.button('Bis zu 20 auswählen'),undefined,'no listed device: no "Choose up to 20" row');
 assert.equal(ui.find(node=>node.props?.className==='sdfau-toolbar'),undefined,'and no .sdfau-toolbar');checks+=5;ui.unmount();
 // Listed devices, none eligible (offline): the row stays and "Choose up to 20" names why it is blocked.
 ui=harness({servers:[device('device-a',{lastSeen:now-3*3600000})]});await ui.settle();ui.open();
 assert.ok(ui.find(node=>node.props?.className==='sdfau-toolbar'),'listed devices keep the choose row');
 assert.equal(ui.button('Bis zu 20 auswählen').props.blocked,'Keines dieser Geräte kann gerade aktualisiert werden.','none eligible: blocked with agentUpdates.fleet.noneEligible');
 assert.equal(ui.find(node=>node.type==='Empty'),undefined,'listed devices: no empty state');checks+=3;ui.unmount();
 ui=harness({get:(_signal,ApiError)=>{throw new ApiError('Katalog nicht erreichbar.',500);}});await ui.settle(()=>true);await new Promise(resolve=>setImmediate(resolve));ui.render();ui.open();
 const notice=ui.find(node=>node.type==='Notice');assert.equal(notice?.props.tone,'danger','errors are a danger Notice');checks++;ui.unmount();
}
// ---- The version cell's update action is the kit Btn (ghost, sm), blocked with kit.busy while a rollout runs ----
{
 const React=(await import('react')).default,{renderToStaticMarkup}=await import('react-dom/server');
 const kit=await import('../../../ui/kit/kit.tsx'),{LocaleProvider}=await import('../../../ui/base/locale.tsx');
 const {translate}=await import('../../../lib/i18n/translate.ts');
 const de=(key,params)=>translate('de',key,params);
 ui=harness();await ui.settle();
 const cell=()=>ui.row(),action=()=>[cell().props.children].flat(Infinity).find(node=>node?.type==='Btn');
 // The loader stubs lucide icons as names; the SSR takes the real icon of that name.
 const lucide=await import('lucide-react');
 const ssr=props=>renderToStaticMarkup(React.createElement(LocaleProvider,{locale:'de'},React.createElement(kit.Btn,{...props,icon:lucide[props.icon]})));
 let btn=action();
 assert.deepEqual([btn.props.variant,btn.props.size,btn.props.icon,btn.props.blocked,btn.props.children],['ghost','sm','ArrowUpCircle',undefined,de('agentUpdates.fleet.update',{version:'4.6.0'})],'a ghost sm kit Btn with ArrowUpCircle and the visible agentUpdates.fleet.update text');
 assert.equal(btn.props['aria-label'],de('agentUpdates.fleet.updateNamed',{name:'DEVICE-A',version:'4.6.0'}),'aria-label is agentUpdates.fleet.updateNamed');
 assert.equal(btn.props.hint,de('agentUpdates.notice.available',{version:'4.6.0'}),'not blocked: the hint is agentUpdates.notice.available (row.reason when there is one)');
 assert.ok(!('title' in btn.props),'no native title');checks+=4;
 let html=ssr(btn.props);
 assert.match(html,/^<button type="button" class="sdx-btn sdx-btn-ghost sdx-btn-sm"/,'SSR: the kit ghost sm button');
 assert.ok(html.includes(`aria-label="${de('agentUpdates.fleet.updateNamed',{name:'DEVICE-A',version:'4.6.0'})}"`)&&!/\stitle=/.test(html)&&!/aria-disabled/.test(html),'SSR: the updateNamed label, no title, not blocked');checks+=2;
 const opened=[];const realOpen=ui.context.open;ui.context.open=id=>opened.push(id);
 btn.props.onClick();assert.deepEqual(opened,['device-a'],'a click opens the updates drawer for the device');checks++;
 // While a rollout runs: blocked with kit.busy, focusable (aria-disabled, no native disabled), the reason as description.
 ui.context.busy=true;btn=action();
 assert.equal(btn.props.blocked,de('kit.busy'),'busy: blocked={t("kit.busy")}');
 html=ssr(btn.props);
 const described=html.match(/aria-describedby="([^"]+)"/)?.[1];
 assert.ok(/aria-disabled="true"/.test(html)&&!/\sdisabled=""/.test(html)&&!/\stitle=/.test(html),'busy SSR: aria-disabled, no native disabled, no title');
 assert.ok(described&&new RegExp(`id="${described}"[^>]*>${de('kit.busy')}<`).test(html),'busy SSR: the kit.busy reason is the aria-describedby description');checks+=3;
 // A blocked kit Btn cancels click, Enter and Space and toggles its Tooltip instead (buttonHandlers, tests/ui/kit/kit-tooltip.mjs).
 ui.context.busy=false;ui.context.open=realOpen;ui.unmount();
 // CSS: the old text link rules are gone, and no bare .sdfau-cell button rule restyles the kit Btn.
 const css=fs.readFileSync('ui/devices/fleet/fleet-agent-updates.css','utf8');
 assert.ok(!css.includes('.sdfau-cell-update'),'no .sdfau-cell-update rule');
 assert.ok(!/\.sdfau-cell button/.test(css),'no bare .sdfau-cell button selector (the kit size, padding, radius, focus ring and press apply)');
 assert.ok(css.includes('.sdfau-cell :is(.sdfau-cell-state,.sdfau-cell-migration){display:flex;')&&/\.sdfau-cell :is\(\.sdfau-cell-state,\.sdfau-cell-migration\)\{[^}]*font-size:10px/.test(css),'the state and migration buttons keep their look');checks+=3;
}
console.log(`PASS fleet Agent update actions (${checks} assertions): shared loading, exact confirmation, duplicate guard, MFA retry, 20-device bulk limit, current eligibility preflight, inactive catalog, heartbeat-confirmed status, the cross-customer lock, the changes from the oldest selected agent, and the version cell's kit Btn with its CSS.`);
