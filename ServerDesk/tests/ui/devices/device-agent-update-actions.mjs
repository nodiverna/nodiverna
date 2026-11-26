// The shared loader resolves the extensionless imports of the helper (ui/base/access-capabilities).
import '../../support/register.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
import {accessCapabilities} from '../../support/access-capabilities.mjs';
const state=await import('../../../lib/agent-update-state.ts');
const updateModel=await import('../../../ui/devices/device/agent-update-model.ts');
const {deviceConnection}=await import('../../../ui/base/ui-device.ts');
let checks=0;
// The shared step-up retry runs as it is; the imports of its hook (useStepUp, unused here) get empty stubs.
const hookStubs={'react':{},'sonner':{toast:{error(){}}},'@/ui/base/api':{message:String}};
const stepUpRetry={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync('ui/session/step-up-retry.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(id=>{const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;if(Object.hasOwn(hookStubs,id))return hookStubs[id];throw Error('Unexpected '+id);},stepUpRetry,stepUpRetry.exports);
const now=Date.now(),sha='a'.repeat(64),release={id:'release-4.4',version:'4.4.0',sha256:sha,size:100,createdAt:now,signature:'test-signature',manifest:JSON.stringify({version:'4.4.0',sha256:sha,size:100,path:'/downloads/agent.zip',protocolVersion:3,minProtocolVersion:3,os:['Windows 11 Pro'],arch:'x64',layout:'single-exe',exe:{path:'/downloads/agent.exe',sha256:sha,size:200}})};
function harness({get,post,initialServer}={}){
 const cells=[],effects=[],calls=[],intervals=new Map(),timers=new Map();let cursor=0,dirty=false,tree,nextTimer=0,confirmations=0;
 const props={server:{id:'device-a',name:'HOST',management:1,lastSeen:now,permissions:['update'],snapshot:{agentVersion:'4.3.0',protocolVersion:3,mode:'Management',agentCapabilities:['agent-update','release-paths']},...initialServer},viewer:{id:'user',permissions:[]},demo:false,jobs:[],now};
 const hooks={useState(initial){const index=cursor++;cells[index]??={value:initial};return[cells[index].value,value=>{const next=typeof value==='function'?value(cells[index].value):value;if(!Object.is(next,cells[index].value)){cells[index].value=next;dirty=true;}}];},useRef(initial){const index=cursor++;cells[index]??={value:{current:initial}};return cells[index].value;},useCallback(fn,deps){const index=cursor++,old=cells[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))cells[index]={deps,value:fn};return cells[index].value;},useEffect(fn,deps){const index=cursor++,old=cells[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))effects.push(()=>{old?.cleanup?.();cells[index]={deps,cleanup:fn()};});}};
 class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
 const jsx=(type,props)=>({type,props:props??{}}),mod={exports:{}};
 const code=ts.transpileModule(fs.readFileSync('ui/devices/device/agent-update-notice.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const api=async(url,payload,signal)=>{calls.push({url,payload,signal});return payload?(post?post(payload,signal,ApiError):{jobs:['job-a'],scheduledAt:now}):(get?get(signal,ApiError):{releases:[release],campaigns:[]});};
 const require=id=>i18nRequire(id)??(id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({}, {get:(_target,key)=>String(key)}):id==='@/ui/kit/kit'?{Btn:'Btn',IconBtn:'IconBtn'}:id==='@/ui/kit/confirm-dialog'?{ConfirmDialog:'ConfirmDialog'}:id==='@/ui/devices/management/management-actions'?{confirmationDevice:name=>[{label:'Gerät',value:name}]}:id==='@/ui/base/ui-device'?{deviceConnection}:id==='@/lib/agent-update-state'?state:id==='@/ui/devices/device/agent-update-model'?updateModel:id==='@/ui/base/access-capabilities'?accessCapabilities:id==='@/ui/base/api'?{api,ApiError,message:error=>error.message,stamp:value=>String(value)}:id==='@/ui/session/mfa-step-up'?{MfaStepUp:'MfaStepUp'}:id==='@/ui/session/step-up-retry'?stepUpRetry.exports:id.endsWith('.css')?{}:(()=>{throw Error('Unexpected '+id);})());
 new Function('require','module','exports','window','setInterval','clearInterval','setTimeout','clearTimeout',code)(require,mod,mod.exports,{confirm:()=>{confirmations++;return true;}},(fn,ms)=>{const id=++nextTimer;intervals.set(id,{fn,ms});return id;},id=>intervals.delete(id),(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},id=>timers.delete(id));
 const Component=mod.exports.default;
 function nodes(node){if(arguments.length===0)node=tree;if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(child=>nodes(child))];}
 const text=node=>[node?.props?.children].flat(Infinity).map(child=>typeof child==='string'||typeof child==='number'?child:child&&typeof child==='object'?text(child):'').join('');
 function render(){let limit=0;do{dirty=false;cursor=0;tree=Component(props);for(const effect of effects.splice(0))effect();if(limit++>8)throw Error('Unstable render');}while(dirty);}
 // Install opens the kit ConfirmDialog (UI-Rework 13b); button() presses Install and confirms the dialog as the user would.
 const find=predicate=>nodes().find(predicate),rawButton=()=>find(node=>node.type==='Btn'&&text(node)==='Installieren'),dialog=()=>find(node=>node.type==='ConfirmDialog');
 const button=()=>{const node=rawButton();return node&&{...node,props:{...node.props,onClick:()=>{node.props.onClick();render();const open=dialog();if(open?.props.open){confirmations++;open.props.onConfirm();}}}};};
 async function settle(predicate=()=>!!button()||!!find(node=>node.props['role']==='alert')){for(let n=0;n<50;n++){await new Promise(resolve=>setImmediate(resolve));if(dirty)render();if(predicate())return;}throw Error('State did not settle');}
 function unmount(){for(const cell of cells)cell?.cleanup?.();}
 render();return {props,calls,intervals,timers,render,find,button,rawButton,dialog,settle,unmount,text:()=>nodes().map(text).join(' '),get confirmations(){return confirmations;}};
}
let resolveList,ui=harness({get:()=>new Promise(resolve=>{resolveList=resolve;})});assert.match(ui.text(),/Updates werden geprüft/);assert.equal(ui.button(),undefined);assert.ok(!ui.text().includes('verfügbar'));checks+=3;resolveList({releases:[release],campaigns:[]});await ui.settle();assert.equal(ui.button().props.blocked,undefined);assert.equal(ui.button().props.loading,false,'the kit Btn starts without a spinner');assert.match(ui.text(),/4\.4\.0 verfügbar/);checks+=2;ui.unmount();
let releaseDeploy;ui=harness({post:()=>new Promise(resolve=>{releaseDeploy=()=>resolve({jobs:['job-a'],scheduledAt:now});})});await ui.settle();ui.button().props.onClick();ui.button().props.onClick();ui.render();assert.equal(ui.calls.filter(call=>call.payload).length,1);assert.equal(ui.confirmations,1);assert.deepEqual(ui.calls.find(call=>call.payload).payload,{action:'deploy',releaseId:release.id,serverIds:['device-a'],confirm:true});checks+=3;releaseDeploy();await ui.settle(()=>ui.text().includes('Update angefordert'));assert.equal(ui.button(),undefined);assert.equal(ui.find(node=>node.type==='MfaStepUp').props.open,false,'a confirmed update on a live MFA session opens no MFA dialog');checks+=2;
ui.props.jobs=[{id:'job-a',serverId:'device-a',action:'agent-update',target:'4.4.0',state:'succeeded',createdAt:now}];ui.render();assert.match(ui.text(),/Wartet auf neue Agentmeldung/);assert.ok(!ui.text().includes('Neue Agentversion bestätigt'));checks+=2;ui.props.server={...ui.props.server,snapshot:{...ui.props.server.snapshot,agentVersion:'4.4.0'}};ui.render();assert.match(ui.text(),/Neue Agentversion bestätigt/);assert.equal(ui.button(),undefined);checks+=2;ui.unmount();
let needMfa=true,getCount=0;ui=harness({get:(_signal,ApiError)=>{if(getCount++&&needMfa)throw new ApiError('Melde dich mit MFA an, um fortzufahren.',403,'MFA_LOGIN_REQUIRED');return {releases:[release],campaigns:[]};},post:(_payload,_signal,ApiError)=>{if(needMfa)throw new ApiError('Melde dich mit MFA an, um fortzufahren.',403,'MFA_LOGIN_REQUIRED');return {jobs:['job-a'],scheduledAt:now};}});await ui.settle();ui.button().props.onClick();ui.render();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp')?.props.open===true);[...ui.intervals.values()].find(timer=>timer.ms===60000).fn();await ui.settle(()=>ui.button()===undefined&&ui.find(node=>node.type==='MfaStepUp')?.props.open===true);checks++;needMfa=false;ui.find(node=>node.type==='MfaStepUp').props.onVerified({managementToken:'proof-1'});ui.render();await ui.settle(()=>ui.text().includes('Update angefordert'));assert.equal(ui.calls.filter(call=>call.payload).length,2);assert.equal(ui.confirmations,1,'fresh verification retries the already confirmed exact release');assert.equal(ui.find(node=>node.type==='MfaStepUp').props.open,false);checks+=3;
assert.deepEqual(ui.calls.filter(call=>call.payload).map(call=>call.payload),[{action:'deploy',releaseId:release.id,serverIds:['device-a'],confirm:true},{action:'deploy',releaseId:release.id,serverIds:['device-a'],confirm:true}],'the resent deploy relies on the renewed MFA session and carries no managementToken');checks++;ui.unmount();
// MFA_STEP_UP_REQUIRED and SESSION_EXPIRED open the dialog too; a verification without a token resends the same release once.
for(const code of ['MFA_STEP_UP_REQUIRED','SESSION_EXPIRED']){
 let lapsed=true;ui=harness({post:(_payload,_signal,ApiError)=>{if(lapsed)throw new ApiError('Bitte erneut anmelden.',code==='SESSION_EXPIRED'?401:403,code);return {jobs:['job-a'],scheduledAt:now};}});await ui.settle();ui.button().props.onClick();ui.render();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp')?.props.open===true);
 lapsed=false;ui.find(node=>node.type==='MfaStepUp').props.onVerified({});ui.render();await ui.settle(()=>ui.text().includes('Update angefordert'));
 assert.deepEqual(ui.calls.filter(call=>call.payload).map(call=>call.payload),[{action:'deploy',releaseId:release.id,serverIds:['device-a'],confirm:true},{action:'deploy',releaseId:release.id,serverIds:['device-a'],confirm:true}],code+': a verification without a token resends the release once');assert.equal(ui.confirmations,1);checks+=2;ui.unmount();
}
// Cancel sends nothing.
ui=harness({post:(_payload,_signal,ApiError)=>{throw new ApiError('Melde dich mit MFA an, um fortzufahren.',403,'MFA_LOGIN_REQUIRED');}});await ui.settle();ui.button().props.onClick();ui.render();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp')?.props.open===true);
ui.find(node=>node.type==='MfaStepUp').props.onClose();ui.render();await ui.settle(()=>ui.find(node=>node.type==='MfaStepUp')?.props.open===false);assert.equal(ui.calls.filter(call=>call.payload).length,1,'cancelling the MFA dialog sends nothing');checks++;ui.unmount();
ui=harness({initialServer:{lastSeen:now-300000}});await ui.settle();assert.match(ui.button().props.blocked,/nicht online/,'offline: the start button is blocked with the reason as its description');assert.equal(ui.button().props.title,undefined,'no native title');assert.match(ui.text(),/nicht online/);checks+=3;ui.unmount();
ui=harness({initialServer:{management:0}});await ui.settle();assert.match(ui.button().props.blocked,/Nur-Lesen-Modus/,'Read-only mode: blocked with the reason');assert.match(ui.text(),/Nur-Lesen-Modus/);checks+=2;
// The re-check after an error is a kit IconBtn with its label; the source has no shadcn Button.
ui=harness({get:(_signal,ApiError)=>{throw new ApiError('Kaputt.',500);}});await ui.settle();const recheck=ui.find(node=>node.type==='IconBtn');assert.equal(recheck.props.label,'Agent-Updates erneut prüfen');assert.equal(typeof recheck.props.onClick,'function');assert.doesNotMatch(fs.readFileSync('ui/devices/device/agent-update-notice.tsx','utf8'),/@\/components\/ui\/|title=\{block/);checks+=3;ui.unmount();ui.unmount();
ui=harness({initialServer:{maintenance:{state:'scheduled',version:'4.4.0',notBefore:now+60000}}});await ui.settle(()=>ui.text().includes('Update geplant'));assert.equal(ui.button(),undefined);assert.equal(ui.calls.filter(call=>call.payload).length,0);checks+=2;ui.unmount();
ui=harness({initialServer:{snapshot:{agentVersion:'3.1.1',protocolVersion:3,mode:'Management',agentCapabilities:['agent-update','release-paths']}}});await ui.settle(()=>ui.text().includes('Nativer Agent'));assert.equal(ui.button(),undefined);assert.match(ui.text(),/installiere den neuen Agent einmal auf diesem Gerät/);checks+=2;ui.unmount();
let resolveOld;ui=harness({get:()=>new Promise(resolve=>{resolveOld=resolve;})});ui.unmount();resolveOld({releases:[release],campaigns:[]});await new Promise(resolve=>setImmediate(resolve));assert.equal(ui.button(),undefined,'unmounted load does not expose a stale available update');checks++;
// The changes cover every version after the installed one: history fills the versions the catalog does not hold.
{
 const changelog=()=>ui.find(node=>node.type==='details'),summary=()=>ui.find(node=>node.type==='summary');
 const textOf=node=>[node?.props?.children].flat(Infinity).map(child=>typeof child==='string'?child:child&&typeof child==='object'?textOf(child):'').join('');
 ui=harness({get:()=>({releases:[release],campaigns:[],history:[{version:'4.4.0',features:['Neu in 4.4.0'],fixes:[]},{version:'4.3.5',features:[],fixes:['Behoben in 4.3.5']},{version:'4.3.0',features:['Schon installiert'],fixes:[]}]})});await ui.settle();
 assert.equal(textOf(summary()),'Änderungen von 4.3.0 bis 4.4.0');
 const headings=ui.find(node=>node.type==='ol').props.children.map(item=>textOf(item.props.children[0]));
 assert.deepEqual(headings,['Agent 4.4.0','Agent 4.3.5'],'newest first, the installed version is not listed');
 const content=textOf(changelog());assert.match(content,/Neu in 4\.4\.0/);assert.match(content,/Behoben in 4\.3\.5/);assert.ok(!content.includes('Schon installiert'));
 assert.equal(ui.find(node=>node.type==='ol').props.children[0].props.children[0].props.children[1].props.className,'mono','the version sits in .mono');
 checks+=6;ui.unmount();
 // A version known only from a catalog release without notes says so.
 const middle={...release,id:'release-4.3.9',version:'4.3.9',changelog:null};
 ui=harness({get:()=>({releases:[release,middle],campaigns:[],history:[]})});await ui.settle();
 assert.equal(textOf(summary()),'Änderungen von 4.3.0 bis 4.4.0');assert.match(textOf(changelog()),/Für 4\.4\.0 ist kein Changelog verfügbar\..*Für 4\.3\.9 ist kein Changelog verfügbar\./);checks+=2;ui.unmount();
 // Without history (or with a broken one) the disclosure stays the single-version text.
 for(const answer of [{releases:[release],campaigns:[]},{releases:[release],campaigns:[],history:'broken'}]){
  ui=harness({get:()=>answer});await ui.settle();
  assert.equal(textOf(summary()),'Änderungen in 4.4.0');assert.equal(ui.find(node=>node.type==='ol'),undefined);assert.match(textOf(changelog()),/noch keinen Changelog/);checks+=3;ui.unmount();
 }
}
// Install asks through the kit ConfirmDialog; Cancel deploys nothing, Confirm deploys once; no window.confirm.
{
 const ui=harness();await ui.settle();
 ui.rawButton().props.onClick();ui.render();
 const ask=ui.dialog();
 assert.deepEqual([ask.props.open,ask.props.title,ask.props.lines,ask.props.body,ask.props.confirmLabel],[true,'Agent 4.4.0 auf HOST installieren?',[{label:'Gerät',value:'HOST'},{label:'Installierte Version',value:'4.3.0',mono:true},{label:'Neue Version',value:'4.4.0',mono:true}],'Der Agent startet neu. Offene Sitzungen oder laufende Aufträge können das Update verzögern.','Installieren'],'the dialog: title, Device, Installed version and New version, the hint and the verb');
 assert.equal(ui.calls.filter(call=>call.payload).length,0,'nothing is deployed before the confirmation');
 ask.props.onOpenChange(false);ui.render();await ui.settle(()=>true);
 assert.equal(ui.dialog().props.open,false,'Cancel closes the dialog');assert.equal(ui.calls.filter(call=>call.payload).length,0,'Cancel deploys nothing');
 ui.rawButton().props.onClick();ui.render();ui.dialog().props.onConfirm();ui.render();await ui.settle(()=>ui.text().includes('Update angefordert'));
 assert.deepEqual(ui.calls.filter(call=>call.payload).map(call=>call.payload),[{action:'deploy',releaseId:release.id,serverIds:['device-a'],confirm:true}],'Confirm deploys the release once');
 assert.doesNotMatch(fs.readFileSync('ui/devices/device/agent-update-notice.tsx','utf8'),/window\.confirm/,'no window.confirm');
 checks+=6;ui.unmount();
}
console.log(`PASS device Agent update actions (${checks} assertions): no false status while loading, exact release/target confirmation, duplicate click guard, MFA retry, queued-to-heartbeat progress, offline/ReadOnly/scheduled/legacy gates, unmount safety and the changes from the installed to the offered agent.`);
