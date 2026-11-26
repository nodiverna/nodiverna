// Exercise the actual DriftPanel handlers with a controlled hook/fetch runtime: the panel file runs on
// hook cells, the kit parts it renders use React (SSR). Demo and missing rights render Unavailable
// without a request; accept and copy go through the kit ConfirmDialog with the classic bodies.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map(),hooks=[],effects=[];
const requests=[],intervals=new Map();let cursor=0,intervalId=0;
const depsEqual=(a,b)=>a&&b&&a.length===b.length&&a.every((item,index)=>Object.is(item,b[index]));
const fakeReact={...React,
 useState(initial){const index=cursor++;if(!hooks[index])hooks[index]={value:typeof initial==='function'?initial():initial};return [hooks[index].value,value=>{hooks[index].value=typeof value==='function'?value(hooks[index].value):value;}];},
 useRef(initial){const index=cursor++;if(!hooks[index])hooks[index]={current:initial};return hooks[index];},
 useCallback(callback,deps){const index=cursor++;if(!hooks[index]||!depsEqual(hooks[index].deps,deps))hooks[index]={deps,callback};return hooks[index].callback;},
 useEffect(callback,deps){const index=cursor++;if(!hooks[index]||!depsEqual(hooks[index].deps,deps)){const previous=hooks[index];hooks[index]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();hooks[index].cleanup=callback();});}},
};
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
function api(url,body,signal){return new Promise((resolve,reject)=>{requests.push({url,body,signal,resolve,reject});});}
const MfaStepUp=()=>null;
const shared={api,ApiError,message:error=>error.message,stamp:value=>String(value??'—'),permitted:(server,viewer,right)=>viewer.permissions?.includes('*')===true||server.permissions?.includes(right),v3:server=>server.snapshot?.protocolVersion===3};
function load(filename){
 const absolute=path.resolve(filename);if(cache.has(absolute))return cache.get(absolute).exports;
 if(absolute.endsWith('.css'))return {};
 const mod={exports:{}};cache.set(absolute,mod);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;
  if(id==='react')return absolute.endsWith('drift-panel.tsx')?fakeReact:React;
  if(id==='@/ui/base/api')return shared;
  if(id==='@/ui/session/mfa-step-up')return {MfaStepUp};
  if(id==='@/ui/devices/remote/file-browser')return {FilePicker:()=>null};
  if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'.js'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}
  return require(id);
 }
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const DriftPanel=load('ui/automation/drift-panel.tsx').default,kit=load('ui/kit/kit.tsx'),{ConfirmDialog}=load('ui/kit/confirm-dialog.tsx'),{de}=await import('../../support/i18n-stubs.mjs');
const viewer={id:'owner',label:'owner@test',permissions:['*']},server={id:'one',name:'SRV-ONE',permissions:['drift.read','drift.manage'],snapshot:{protocolVersion:3,agentCapabilities:[]}};
const policy={enabled:true,version:3,paths:[{path:'C:\Config',recursive:true,includeText:false,extensions:['.txt']}],excludes:['*.log'],registry:[],config:['services'],includeConfigValues:false,intervalSeconds:300,maxFiles:1000,maxFileBytes:10485760,maxTextBytes:8192,maxDurationSeconds:30,retentionDays:30};
const data={policy,state:'in_sync',baseline:{id:'base',reportId:'base-report',policyVersion:3,createdAt:Date.now(),createdBy:'owner'},baselines:[],current:{id:'report',policyVersion:3,scannedAt:Date.now(),receivedAt:Date.now(),firstScannedAt:Date.now(),scanCount:1,complete:true,state:'in_sync',changes:[],errors:[]},history:[],reports:[],retentionDays:30,historyLimit:200};
let props={server,viewer,demo:false},tree;
function render(next){if(next)props=next;cursor=0;tree=DriftPanel(props);while(effects.length)effects.shift()();return tree;}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const item of node){const found=find(item,predicate);if(found)return found;}return null;}if(predicate(node))return node;return find(node.props?.children,predicate);}
const text=node=>node==null?'':typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):typeof node==='object'?text(node.props?.children):String(node);
const control=()=>find(tree,node=>node.props?.role==='switch');
const disclosure=()=>find(tree,node=>String(node.props?.className??'').split(' ').includes('drift-policy-disclosure'));
const mfa=()=>find(tree,node=>node.type===MfaStepUp);
const button=label=>find(tree,node=>node.type===kit.Btn&&text(node.props.children).includes(label));
const dialogs=()=>{const found=[];const walk=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}if(node.type===ConfirmDialog)found.push(node);walk(node.props?.children);};walk(tree);return found;};
const settle=async()=>{for(let index=0;index<10;index++)await Promise.resolve();};
async function reply(request,value){request.resolve(structuredClone(value));await settle();render();}
const originals={setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval,window:globalThis.window};
globalThis.setInterval=callback=>{intervals.set(++intervalId,callback);return intervalId;};globalThis.clearInterval=id=>intervals.delete(id);
globalThis.window={confirm:()=>true};
try{
 render();assert.equal(requests.length,1);await reply(requests[0],data);
 let html=renderToStaticMarkup(tree);assert.match(html,/role="switch"[^>]*aria-label="Drift-Überwachung auf diesem Gerät"[^>]*aria-checked="true"/);assert.doesNotMatch(html,/Überwachung aktivieren|Richtlinie bearbeiten|Richtlinie schließen/);assert.ok(html.indexOf('aria-label="Verlauf"')<html.indexOf('drift-policy-disclosure'));
 assert.match(html,/<h2 class="sr-only">Konfigurationsdrift<\/h2>/,'the tab label is only the accessible heading');assert.ok(html.includes(de('drift.description')),'the visible description');assert.equal(disclosure().props.open,false);
 const excludes=()=>find(tree,node=>node.type==='textarea'&&node.props.value!=='');
 excludes().props.onChange({target:{value:'*.unsaved'}});render();
 disclosure().props.onToggle({currentTarget:{open:true}});render();assert.equal(disclosure().props.open,true);disclosure().props.onToggle({currentTarget:{open:false}});render();assert.equal(excludes().props.value,'*.unsaved','closing the disclosure keeps draft values');
 const before=requests.length;control().props.onClick();control().props.onClick();assert.equal(requests.length,before+1,'double click before a React rerender creates only one write');
 const toggleRequest=requests.at(-1);assert.deepEqual(toggleRequest.body,{action:'set-enabled',serverId:'one',enabled:false,version:3},'the switch sends only the saved activation state and version');render();assert.equal(control().props['aria-checked'],true,'until the server confirms, the switch retains its saved value');assert.equal(control().props['aria-disabled'],true);
 await reply(toggleRequest,{policyId:'policy',version:3,enabled:false});await reply(requests.at(-1),{...data,policy:{...policy,enabled:false},state:'disabled'});assert.equal(control().props['aria-checked'],false);assert.equal(excludes().props.value,'*.unsaved','activation refresh does not overwrite unsaved draft fields');
 button('Richtlinie speichern').props.onClick();assert.equal(requests.at(-1).body.policy.enabled,false,'saving other changes uses the current saved activation state');assert.deepEqual(requests.at(-1).body.policy.excludes,['*.unsaved']);await reply(requests.at(-1),{enabled:false});await reply(requests.at(-1),{...data,policy:{...policy,enabled:false,excludes:['*.unsaved']},state:'disabled'});
 // An expired step-up rolls back to the confirmed state and retries the exact
 // switch operation after MFA; no draft fields are added to the retry.
 control().props.onClick();const failed=requests.at(-1);failed.reject(new ApiError('MFA-Bestätigung erforderlich.',403,'MFA_STEP_UP_REQUIRED'));await settle();render();assert.equal(control().props['aria-checked'],false);assert.equal(mfa().props.open,true);assert.equal(control().props['aria-disabled'],true);
 mfa().props.onVerified();assert.deepEqual(requests.at(-1).body,failed.body);const retry=requests.at(-1);retry.reject(new ApiError('Richtlinie wurde geändert.',409));await settle();render();const conflictRead=requests.at(-1);await reply(conflictRead,{...data,policy:{...policy,version:4,enabled:false},state:'disabled'});assert.equal(control().props['aria-checked'],false);assert.equal(excludes().props.value,'*.unsaved');html=renderToStaticMarkup(tree);assert.match(html,/Richtlinie wurde geändert/,'reconciliation keeps the conflict explanation visible');
 // A read started before an activation change may return after the write. It
 // must neither overwrite the confirmed switch nor reset the draft.
 [...intervals.values()][0]();const oldRead=requests.at(-1);control().props.onClick();const activation=requests.at(-1);assert.equal(oldRead.signal.aborted,true);await reply(activation,{policyId:'policy',version:4,enabled:true});const freshRead=requests.at(-1);await reply(freshRead,{...data,policy:{...policy,version:4,enabled:true}});await reply(oldRead,{...data,policy:{...policy,version:4,enabled:false},state:'disabled'});assert.equal(control().props['aria-checked'],true,'late read cannot roll back successful activation');assert.equal(excludes().props.value,'*.unsaved');
 // Scope changes abort in-flight writes and make previous callbacks inert.
 control().props.onClick();const oldWrite=requests.at(-1),oldRetry=mfa().props.onVerified;render({...props,server:{...server,id:'two',name:'SRV-TWO'}});assert.equal(oldWrite.signal.aborted,true);const nextRead=requests.at(-1);await reply(oldWrite,{enabled:false,version:4});assert.equal(control(),null,'another device does not inherit a late write result');oldRetry();assert.equal(requests.at(-1),nextRead,'a stale MFA callback does not issue another mutation');await reply(nextRead,{...data,policy:{...policy,enabled:true,version:6}});assert.equal(control().props['aria-checked'],true);
 control().props.onClick();requests.at(-1).reject(new ApiError('MFA-Bestätigung erforderlich.',403,'MFA_STEP_UP_REQUIRED'));await settle();render();assert.equal(mfa().props.open,true);const pendingRetry=mfa().props.onVerified;
 render({...props,server:{...server,id:'three',name:'SRV-THREE'}});const thirdRead=requests.at(-1);pendingRetry();assert.equal(requests.at(-1),thirdRead,'a real pending MFA operation cannot migrate to another device');await reply(thirdRead,{...data,policy:{enabled:false},state:'disabled'});assert.equal(control().props['aria-disabled'],true,'activation first needs a saved policy');assert.match(renderToStaticMarkup(tree),new RegExp(de('drift.blocked.saveFirst')),'and says so as the switch hint');
 render({...props,viewer:{...viewer,permissions:[]},server:{...props.server,permissions:['drift.read']}});await reply(requests.at(-1),data);assert.equal(control().props['aria-disabled'],true);const count=requests.length;control().props.onClick();assert.equal(requests.length,count,'readers cannot write by invoking the handler');
 html=renderToStaticMarkup(tree);const saveMarkup=html.match(/<button[^>]*>(?:(?!<\/button>).)*<span>Richtlinie speichern<\/span>(?:(?!<\/button>).)*<\/button>/)?.[0]??'';
 assert.ok(/aria-disabled="true"/.test(saveMarkup)&&saveMarkup.includes(de('drift.blocked.manage'))&&!/ disabled=""/.test(saveMarkup),'readers: "Richtlinie speichern" is blocked with the right');
 assert.ok(find(tree,node=>node.type==='textarea').props.readOnly===true&&find(tree,node=>node.type==='input'&&node.props.type==='number').props.readOnly===true,'readers: the fields are read-only');
 button('Richtlinie speichern').props.onClick();assert.equal(requests.length,count,'a blocked save sends nothing');
 // ---- Accept as baseline and Copy to group: kit ConfirmDialog, the classic bodies ----
 const drifted={...data,state:'drifted',baseline:{...data.baseline},current:{...data.current,id:'scan-2',state:'drifted',changes:[{key:'file:a',kind:'file',path:'C:\\Config\\a.json',change:'modified'}]}};
 render({...props,viewer,server:{...server,id:'four',name:'SRV-FOUR'},groups:[{id:'g1',name:'Berlin'}]});await reply(requests.at(-1),{...drifted,policy:{...policy,version:3}});
 assert.equal(dialogs().every(dialog=>dialog.props.open===false),true,'no confirmation is open');
 const overview=find(tree,node=>typeof node.props?.onAccept==='function');overview.props.onAccept(drifted.current);render();
 const accept=dialogs().find(dialog=>dialog.props.open);assert.deepEqual([accept.props.title,accept.props.confirmLabel,accept.props.lines.map(line=>line.label),accept.props.lines[0].value],['Diesen Scan als Baseline für SRV-FOUR übernehmen?','Als Baseline übernehmen',['Gerät','Scan'],'SRV-FOUR'],'accept asks with the trigger verb and the device and scan lines');
 let sent=requests.length;accept.props.onConfirm();render();assert.deepEqual(requests.at(-1).body,{action:'accept-baseline',serverId:'four',reportId:'scan-2',confirm:true},'accept sends the classic body');assert.equal(requests.length,sent+1);
 await reply(requests.at(-1),{});await reply(requests.at(-1),drifted);
 find(tree,node=>(node.type==='select'||node.type?.render?.name==='Select')&&node.props.value==='').props.onChange({target:{value:'g1'}});render();
 assert.ok(button('In Gruppe kopieren'),'with a target group the primary reads "In Gruppe kopieren"');sent=requests.length;button('In Gruppe kopieren').props.onClick();render();assert.equal(requests.length,sent,'copying asks first');
 const copy=dialogs().find(dialog=>dialog.props.open);assert.deepEqual([copy.props.title,copy.props.confirmLabel,copy.props.lines],['Richtlinie in die Gruppe Berlin kopieren?','In Gruppe kopieren',[{label:'Gruppe',value:'Berlin'}]],'copy asks with the group');
 copy.props.onConfirm();render();const body=requests.at(-1).body;assert.deepEqual([body.action,body.groupId,body.confirm,body.policy.excludes],['apply-group','g1',true,['*.log']],'copy sends the classic apply-group body');
 assert.doesNotMatch(fs.readFileSync('ui/automation/drift-panel.tsx','utf8')+fs.readFileSync('ui/automation/drift-overview.tsx','utf8'),/window\.confirm|CapabilityNote|DetailDrawer|LoadingSkeleton|ErrorNote|@\/components\/ui\//,'no window.confirm and no classic parts');
 await reply(requests.at(-1),{});await reply(requests.at(-1),drifted);
 // ---- Unavailable: demo and the missing right, without a request or an interval ----
 for(const [label,next,sentence] of [['demo',{...props,demo:true,server:{...server,id:'five'}},de('kit.unavailable.demo')],['right',{...props,viewer:{...viewer,permissions:[]},server:{...server,id:'six',permissions:['view']}},de('kit.unavailable.right')]]){
  const counted=requests.length,timers=intervalId;render(next);html=renderToStaticMarkup(tree);
  assert.ok(html.includes(sentence)&&/sdx-notice-info/.test(html),`${label}: Unavailable with "${sentence}"`);
  assert.equal(requests.length,counted,`${label}: no request`);assert.equal(intervalId,timers,`${label}: no new interval`);assert.equal(intervals.size,0,`${label}: no interval runs`);
  if(label==='demo')assert.ok(!html.includes(de('kit.unavailable.right'))&&!html.includes('Berechtigungen'),'demo: not the rights sentence');
 }
 console.log('PASS: actual Drift UI disclosure, saved-only switch, draft preservation, serialized clicks, error/MFA handling, read order, scope cancellation and permission guard.');
}finally{for(const hook of hooks)hook?.cleanup?.();globalThis.setInterval=originals.setInterval;globalThis.clearInterval=originals.clearInterval;globalThis.window=originals.window;}
