// Exercise actual auth components and API transport with browser-controlled cookies, and the hand-over of an
// ended session (idle or other) from SessionGate to the normal sign-in card for built-in and Entra accounts.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map(),at=Date.now(),origin='https://serverdesk.test';
let active=null,hookIndex=0,network=[],replies=[],navigations=[],historyChanges=[];
const sameDeps=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
const react={...React,
 useState(initial){const index=hookIndex++,owner=active;if(!owner.hooks[index])owner.hooks[index]={value:typeof initial==='function'?initial():initial};const slot=owner.hooks[index];return [slot.value,next=>{const value=typeof next==='function'?next(slot.value):next;if(!Object.is(slot.value,value)){slot.value=value;owner.dirty=true;}}];},
 useRef(initial){const index=hookIndex++;if(!active.hooks[index])active.hooks[index]={current:initial};return active.hooks[index];},
 useMemo(fn,deps){const index=hookIndex++,previous=active.hooks[index];if(previous&&sameDeps(previous.deps,deps))return previous.value;const value=fn();active.hooks[index]={value,deps};return value;},
 useCallback(fn,deps){return react.useMemo(()=>fn,deps);},
 useEffect(fn,deps){const index=hookIndex++,previous=active.hooks[index];if(previous&&sameDeps(previous.deps,deps))return;active.hooks[index]={deps,cleanup:previous?.cleanup};active.pending.push({index,fn});},
};
function Console(){return null;}function SessionGate(){return null;}function MfaStepUp(){return null;}
const gateSource=fs.readFileSync(path.join(root,'ui/session/session-gate.tsx'),'utf8');
function load(filename){
 const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 const mod={exports:{}};cache.set(absolute,mod);const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;if(id==='react')return react;if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate){if(candidate===path.join(root,'ui/shell/console.tsx'))return {default:Console,__esModule:true};if(candidate===path.join(root,'ui/session/session-gate.tsx'))return {default:SessionGate,entraStartPath:gateSource.match(/export const entraStartPath='([^']+)'/)[1],__esModule:true};if(candidate===path.join(root,'ui/session/mfa-step-up.tsx'))return {MfaStepUp};return load(candidate);}}return require(id);}
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
class Harness{
 constructor(component,props={}){this.component=component;this.props=props;this.hooks=[];this.pending=[];this.dirty=true;this.render();}
 render(){active=this;hookIndex=0;this.dirty=false;this.pending=[];this.tree=this.component(this.props);for(const effect of this.pending){const slot=this.hooks[effect.index];slot.cleanup?.();slot.effect=effect.fn;slot.cleanup=effect.fn();}active=null;}
 replayEffects(){for(const slot of this.hooks){if(!slot?.effect)continue;slot.cleanup?.();slot.cleanup=slot.effect();}}
 async settle(){for(let turn=0;turn<3;turn++){for(let i=0;i<30;i++){await Promise.resolve();if(this.dirty)this.render();}await new Promise(resolve=>setTimeout(resolve,0));}}
 dispose(){for(const slot of this.hooks)slot?.cleanup?.();}
}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const child of node){const result=find(child,predicate);if(result)return result;}return null;}if(predicate(node))return node;return find(node.props?.children,predicate);}
function input(harness,id,value){const node=find(harness.tree,item=>item.props?.id===id);assert.ok(node,`input ${id} exists`);node.props.onChange({target:{value}});harness.render();}
const submit=harness=>{const form=find(harness.tree,item=>item.type==='form');assert.ok(form);return form.props.onSubmit({preventDefault(){}});};
const byType=(harness,type)=>find(harness.tree,item=>item.type===type);
const viewer={id:'local-user-id',userId:'local-user-id',label:'user@example.test',username:'server.user',displayName:'Server User',permissions:[]};
const anonymous={viewer:null,passwordConfigured:false};
// Session tokens travel only in HttpOnly cookies: no request carries these headers.
const credentialHeaders=['X-ServerDesk-Session','X-ServerDesk-Mfa','X-ServerDesk-Embedded'];
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const windowTarget=new EventTarget();windowTarget.top={};windowTarget.self=windowTarget;windowTarget.location={origin,href:origin+'/',pathname:'/',search:'',hash:'',replace:target=>navigations.push(target)};windowTarget.history={state:{},replaceState(state,_title,url){historyChanges.push(url);windowTarget.location.hash='';windowTarget.location.href=origin+url;}};globalThis.window=windowTarget;globalThis.document=new EventTarget();
globalThis.fetch=async(input,init={})=>{
 const url=new URL(input instanceof Request?input.url:String(input),origin),record={path:url.pathname,method:init.method??'GET',headers:new Headers(init.headers),signal:init.signal,body:init.body?JSON.parse(init.body):undefined,hash:window.location.hash};network.push(record);const next=replies.shift();if(next===undefined)throw new Error('Unexpected request '+record.method+' '+record.path);if(next?.promise)return new Promise((resolve,reject)=>{const aborted=()=>reject(init.signal.reason??new DOMException('Aborted','AbortError'));init.signal?.addEventListener('abort',aborted,{once:true});next.promise.then(value=>{init.signal?.removeEventListener('abort',aborted);resolve(value);},reject);});return typeof next==='function'?next(record):next;
};
const IdentityEntry=load('ui/session/identity-entry.tsx').default,PasswordSettings=load('ui/account/password-settings.tsx').default,http=load('ui/base/http.ts'),validation=load('ui/session/identity-password.ts'),RealMfaStepUp=load('ui/session/mfa-step-up.tsx').MfaStepUp;
const harnesses=[];function mount(component,props){const harness=new Harness(component,props);harnesses.push(harness);return harness;}
function disposeAll(){for(const harness of harnesses.splice(0))harness.dispose();}
function reset(hash=''){disposeAll();network=[];replies=[];navigations=[];historyChanges=[];window.location.hash=hash;window.location.href=origin+'/'+hash;}
function enqueue(data,status=200){replies.push(Response.json(data,{status}));}
function fillLogin(harness){input(harness,'identity-username','server.user');input(harness,'identity-password','fifteen-character-passphrase');}
// The Password method keeps its secondary "Change password" in the SectionHead actions; the Drawer holds the form.
const changePassword=harness=>{const section=find(harness.tree,node=>node.props?.id==='account-password-title');assert.ok(section,'the Password method section');return section.props.actions;};
const passwordDrawer=harness=>find(harness.tree,node=>node.props?.title==='Passwort ändern'&&'dirty' in (node.props??{}));
function fillPassword(harness){input(harness,'account-current-password','old-password-phrase');input(harness,'account-new-password','new-password-phrase');input(harness,'account-new-password-confirm','new-password-phrase');}
try{
 // Kit controls on the sign-in card: a Skeleton while checking, one primary submit that says why it waits.
 const {Btn,Skeleton}=load('ui/kit/kit.tsx'),signInSubmit=harness=>find(harness.tree,node=>node.type===Btn&&node.props.type==='submit');
 reset();enqueue(anonymous);let entry=mount(IdentityEntry);assert.equal(find(entry.tree,node=>node.type===Skeleton)?.props.label,'Anmeldung wird geprüft','a kit Skeleton with the existing label while checking');await entry.settle();
 assert.equal(signInSubmit(entry).props.variant,'primary','Sign in is the one primary of the card');assert.ok(signInSubmit(entry).props.blocked,'an empty form blocks the submit with a reason');assert.equal(signInSubmit(entry).props.disabled,undefined,'no native disabled');assert.equal(network.length,1);assert.equal(network[0].method,'GET');assert.ok(credentialHeaders.every(name=>network[0].headers.get(name)===null),'no credential or embedded header, also inside a frame');assert.equal(byType(entry,Console),null);assert.equal(byType(entry,SessionGate),null);assert.equal(find(entry.tree,node=>node.props?.id==='identity-password').props.autoComplete,'current-password');assert.equal(find(entry.tree,node=>typeof node.props?.href==='string'&&node.props.href.includes('signin-with')),null,'the sign-in page links to no external account login');
 const pending=deferred();replies.push(pending);fillLogin(entry);submit(entry);submit(entry);assert.equal(network.length,2,'rapid submits are single-flight');assert.deepEqual(network[1].body,{action:'login',username:'server.user',password:'fifteen-character-passphrase'});pending.resolve(Response.json({ok:true,viewer}));await entry.settle();assert.equal(entry.tree.type,SessionGate,'password result is still gated by MFA');assert.equal(entry.tree.props.viewer.id,viewer.id);assert.equal(navigations.length,0,'the login mounts SessionGate from the reply viewer without a reload');enqueue({ok:true});await http.credentialFetch('/api/console');assert.equal(network.at(-1).headers.get('X-ServerDesk-Session'),null,'later requests authenticate through the cookie only');assert.ok(credentialHeaders.every(name=>network.at(-1).headers.get(name)===null));


 // A stale classic preference in storage or the URL no longer matters: there is one console.
 {const stored=new Map([['serverdesk.ui','classic']]);windowTarget.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)};
  reset();window.location.search='?ui=klassisch';window.location.href=origin+'/?ui=klassisch';
  try{enqueue(anonymous);entry=mount(IdentityEntry);await entry.settle();fillLogin(entry);enqueue({ok:true,viewer});submit(entry);await entry.settle();
   assert.equal(entry.tree.type,SessionGate,'the signed-in tree starts at the session gate');assert.equal(entry.tree.props.children.type,Console,'the console is the only child, whatever serverdesk.ui and ?ui= say');assert.deepEqual(entry.tree.props.children.props.viewer,viewer,'the console gets the signed-in viewer');
   assert.equal(stored.get('serverdesk.ui'),'classic','the stale preference is ignored, not rewritten');assert.equal(window.location.search,'?ui=klassisch','the ?ui= parameter is ignored, not stripped');}
  finally{delete windowTarget.localStorage;window.location.search='';}}

 const token='d'.repeat(64);reset('#invite='+token);enqueue({valid:true,kind:'invite',username:'new.user',displayName:'New User',expiresAt:at+3600000});entry=mount(IdentityEntry);await entry.settle();assert.deepEqual(historyChanges,['/']);assert.equal(network[0].hash,'','token stripped before API request');assert.deepEqual(network[0].body,{action:'invitation-info',token});input(entry,'identity-password','new-user-password-phrase');input(entry,'identity-password-confirm','new-user-password-phrase');enqueue({ok:true,viewer});submit(entry);await entry.settle();assert.equal(network[1].body.action,'redeem');assert.equal(network[1].body.token,token);assert.equal(entry.tree.type,SessionGate,'new account still needs MFA');assert.equal(navigations.length,0);

 reset('#invite='+token);enqueue({valid:true,kind:'reset',username:'server.user',displayName:'Server User',expiresAt:at+3600000});entry=mount(IdentityEntry);await entry.settle();assert.equal(find(entry.tree,node=>node.props?.id==='identity-username').props.disabled,true);input(entry,'identity-password','new-user-password-phrase');input(entry,'identity-password-confirm','new-user-password-phrase');enqueue({ok:true,loginRequired:true});submit(entry);await entry.settle();assert.equal(byType(entry,SessionGate),null,'password reset cannot sign in or bypass MFA');assert.equal(find(entry.tree,node=>node.props?.id==='identity-password').props.value,'');assert.equal(find(entry.tree,node=>node.props?.id==='identity-password').props.autoComplete,'current-password');

 reset('#invite=invalid');entry=mount(IdentityEntry);await entry.settle();assert.equal(network.length,0,'invalid tokens cannot hit an auth endpoint');assert.equal(byType(entry,SessionGate),null);assert.deepEqual(historyChanges,['/']);

 reset('#invite='+token);const initialInfo=deferred();replies.push(initialInfo);entry=mount(IdentityEntry);enqueue({valid:true,kind:'invite',username:'new.user',displayName:'New User',expiresAt:at+3600000});entry.replayEffects();await entry.settle();assert.equal(network.length,2,'React effect replay restarts the cancelled request');assert.ok(network.every(call=>call.body?.action==='invitation-info'&&call.body.token===token),'stripped token survives only in the mounted component ref');assert.deepEqual(historyChanges,['/'],'effect replay never re-exposes the fragment');assert.equal(find(entry.tree,node=>node.props?.id==='identity-username').props.value,'new.user');

 reset();enqueue(anonymous);entry=mount(IdentityEntry);await entry.settle();const late=deferred();replies.push(late);fillLogin(entry);submit(entry);entry.dispose();assert.equal(network.at(-1).signal.aborted,true,'unmount cancels password request');late.resolve(Response.json({ok:true,viewer}));await entry.settle();assert.equal(navigations.length,0);assert.notEqual(entry.tree.type,SessionGate,'late reply cannot mount the console');enqueue({ok:true});await http.credentialFetch('/api/probe');assert.equal(network.at(-1).headers.get('X-ServerDesk-Session'),null,'no request ever carries an identity header');

 // Microsoft sign-in only with Microsoft on: Microsoft is the only primary action, the password form waits behind "Use emergency access".
 {const expected={intro:'Melde dich mit deinem Microsoft-Arbeitskonto an.',open:'Notfallzugang verwenden',hint:'Mit Passwort kann sich nur das Konto für den Notfallzugang anmelden. Jede Anmeldung damit alarmiert alle Owner.'};
  const words=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':Array.isArray(node)?node.map(words).join(''):words(node.props?.children);
  // The emergency access is a kit Disclosure: its title, open state and onOpenChange drive the form.
  const toggle=harness=>find(harness.tree,node=>node.props?.className==='sd-identity-emergency-toggle'&&typeof node.props?.onOpenChange==='function');
  const hint=harness=>find(harness.tree,node=>node.props?.className==='sd-identity-emergency-hint');
  reset();enqueue({viewer:null,passwordConfigured:true,entra:{enabled:true,entraOnly:true}});entry=mount(IdentityEntry);await entry.settle();
  assert.ok(find(entry.tree,node=>node.type==='p'&&words(node)===expected.intro),'the intro asks for the Microsoft work account');
  const choice=find(entry.tree,node=>node.props?.onStart);assert.equal(choice.props.divider,false,'Sign in with Microsoft without the "or" divider');
  assert.equal(find(entry.tree,node=>node.props?.id==='identity-username'),null,'the password form is collapsed');assert.equal(hint(entry),null);
  assert.equal(toggle(entry).props.open,false,'the disclosure is closed');assert.equal(toggle(entry).props.title,expected.open,'labelled Use emergency access');
  toggle(entry).props.onOpenChange(true);entry.render();
  assert.equal(toggle(entry).props.open,true,'the disclosure is open');
  const opened=find(entry.tree,node=>node.props?.id==='identity-emergency');assert.equal(opened.props.className,'sd-identity-emergency','the form fades in (sdx-fade in identity-entry.css)');
  assert.equal(words(hint(entry)),expected.hint,'the hint names the emergency access');
  assert.equal(find(entry.tree,node=>node.props?.id==='identity-username').props.autoFocus,true,'focus moves to the user name field');
  fillLogin(entry);enqueue({ok:true,viewer});submit(entry);await entry.settle();assert.deepEqual(network.at(-1).body,{action:'login',username:'server.user',password:'fifteen-character-passphrase'},'the emergency access signs in with the same login');assert.equal(entry.tree.type,SessionGate,'and passes the MFA gate');
  // Microsoft off: only the emergency access can sign in, so the form shows at once with the hint.
  reset();enqueue({viewer:null,passwordConfigured:true,entra:{enabled:false,entraOnly:true}});entry=mount(IdentityEntry);await entry.settle();
  assert.equal(toggle(entry),null,'no disclosure while Microsoft is off');assert.equal(find(entry.tree,node=>node.props?.onStart),null,'no Microsoft button');
  assert.equal(words(hint(entry)),expected.hint,'the hint shows at once');assert.equal(find(entry.tree,node=>node.props?.id==='identity-username').props.autoFocus,false,'no focus jump on load');
  // Without Microsoft sign-in only: no hint, no disclosure.
  reset();enqueue({viewer:null,passwordConfigured:true,entra:{enabled:true,entraOnly:false}});entry=mount(IdentityEntry);await entry.settle();
  assert.equal(toggle(entry),null);assert.equal(hint(entry),null);assert.ok(find(entry.tree,node=>node.props?.id==='identity-username'),'the form shows next to Microsoft as before');assert.equal(find(entry.tree,node=>node.props?.onStart).props.divider,true);}
 reset();let confirmed,cancelled;let settings=mount(PasswordSettings,{viewer,onConfirmIdentity:(yes,no)=>{confirmed=yes;cancelled=no;}});changePassword(settings).props.onClick();settings.render();assert.equal(passwordDrawer(settings).props.open,true,'Change password opens the Drawer');fillPassword(settings);assert.equal(passwordDrawer(settings).props.dirty,true,'typed input makes the Drawer dirty');submit(settings);settings.render();assert.equal(network.length,0,'passwordchange requires fresh MFA first');assert.equal(passwordDrawer(settings).props.open,false,'the Drawer waits during the step-up');cancelled();settings.render();assert.equal(passwordDrawer(settings).props.open,true,'a cancelled step-up returns to the Drawer');assert.equal(find(settings.tree,node=>node.props?.id==='account-current-password').props.value,'old-password-phrase','the input is kept');submit(settings);enqueue({ok:true,loginRequired:true});confirmed({managementToken:'password-proof'});await settings.settle();assert.deepEqual(network[0].body,{action:'password-change',currentPassword:'old-password-phrase',newPassword:'new-password-phrase',managementToken:'password-proof'});assert.deepEqual(navigations,['/'],'passwordchange requires a fresh login');

 reset();settings=mount(PasswordSettings,{viewer,onConfirmIdentity:(yes,no)=>{confirmed=yes;cancelled=no;}});changePassword(settings).props.onClick();settings.render();fillPassword(settings);submit(settings);window.dispatchEvent(new Event(http.SESSION_LOCK_EVENT));settings.render();confirmed({managementToken:'stale-proof'});await settings.settle();assert.equal(network.length,0,'session lock invalidates pending password intent');
 reset();const verified=[];let closed=0;enqueue({available:false,count:0});const actualStepUp=mount(RealMfaStepUp,{open:true,onClose:()=>closed++,onVerified:proof=>verified.push(proof)});await actualStepUp.settle();input(actualStepUp,'v3-stepup','123456');const confirmationButton=find(actualStepUp.tree,node=>typeof node.props?.onClick==='function'&&node.props.children==='Bestätigen');assert.ok(confirmationButton);const verification=deferred();replies.push(verification);confirmationButton.props.onClick();confirmationButton.props.onClick();assert.equal(network.filter(call=>call.body?.action==='verify').length,1,'real MFA step-up blocks same-tick double submission');verification.resolve(Response.json({ok:true,managementToken:'single-proof'}));await actualStepUp.settle();assert.equal(verified.length,1,'only successful fresh MFA proof reaches the password intent');assert.equal(verified[0].managementToken,'single-proof');assert.equal(closed,1);
 assert.match(validation.passwordProblem('short','short'),/mindestens 15/);assert.equal(validation.passwordProblem('🔐'.repeat(15),'🔐'.repeat(15)),'','password policy counts Unicode code points');assert.match(validation.passwordProblem('a'.repeat(129),'a'.repeat(129)),/höchstens 128/);assert.notEqual(validation.passwordProblem('long-password-phrase','different-password-phrase'),'');assert.equal(validation.usernameProblem('USER@example.test'),'');assert.notEqual(validation.usernameProblem('ab'),'');
 // The session ends: SessionGate hands over to the normal sign-in card without a reload (docs/portal-sessions.md).
 {const {Notice}=load('ui/kit/kit.tsx'),notice=harness=>find(harness.tree,node=>node.type===Notice&&node.props.tone==='info'),words=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':Array.isArray(node)?node.map(words).join(''):words(node.props?.children);
  // A built-in account after the idle deadline: the idle notice, the username filled in, the focus in the password field.
  reset();enqueue(anonymous);entry=mount(IdentityEntry);await entry.settle();fillLogin(entry);enqueue({ok:true,viewer});submit(entry);await entry.settle();
  assert.equal(typeof entry.tree.props.onSessionEnded,'function','SessionGate gets the hand-over callback');
  enqueue({viewer:null,passwordConfigured:false,entra:{enabled:false}});entry.tree.props.onSessionEnded({reason:'idle',idleTimeoutMs:15*60_000});await entry.settle();
  assert.equal(byType(entry,SessionGate),null,'the console and its gate are gone');assert.equal(navigations.length,0,'no reload');
  assert.equal(network.at(-1).method,'GET','the card reads the sign-in options again');
  assert.equal(words(notice(entry)),'Du wurdest nach 15 Minuten ohne Aktivität abgemeldet. Melde dich erneut an, um weiterzuarbeiten.','the idle notice at the top');
  assert.equal(find(entry.tree,node=>node.props?.id==='identity-username').props.value,'server.user','the username is filled in');
  assert.equal(find(entry.tree,node=>node.props?.id==='identity-password').props.autoFocus,true,'the focus is in the password field');
  assert.equal(find(entry.tree,node=>node.props?.id==='identity-password').props.value,'','the password is empty');
  assert.equal(find(entry.tree,node=>node.props?.onStart),null,'no Microsoft button while Microsoft sign-in is off');
  // The same sign-in as after Sign out: the password, then SessionGate for the second factor; the notice goes.
  input(entry,'identity-password','fifteen-character-passphrase');enqueue({ok:true,viewer});submit(entry);await entry.settle();
  assert.deepEqual(network.at(-1).body,{action:'login',username:'server.user',password:'fifteen-character-passphrase'},'the normal login');assert.equal(entry.tree.type,SessionGate,'then the gate of the second factor');
  // One minute: the singular form.
  enqueue(anonymous);entry.tree.props.onSessionEnded({reason:'idle',idleTimeoutMs:60_000});await entry.settle();
  assert.equal(words(notice(entry)),'Du wurdest nach 1 Minute ohne Aktivität abgemeldet. Melde dich erneut an, um weiterzuarbeiten.','one minute');
  // An Entra account after any other end: the general notice, Sign in with Microsoft with the focus, no username.
  const entraViewer={...viewer,id:'entra-user-id',userId:'entra-user-id',username:'entra.99999999-8888-4777-8666-555555555555',identitySource:'entra',entra:{tenantId:'t',objectId:'o',email:'ada@contoso.example'}};
  reset();enqueue({viewer:entraViewer,passwordConfigured:true,entra:{enabled:true,entraOnly:false}});entry=mount(IdentityEntry);await entry.settle();
  assert.equal(entry.tree.type,SessionGate,'a signed-in Entra account starts at the gate');
  enqueue({viewer:null,passwordConfigured:false,entra:{enabled:true,entraOnly:false}});entry.tree.props.onSessionEnded({reason:'ended',idleTimeoutMs:15*60_000});await entry.settle();
  assert.equal(words(notice(entry)),'Deine Sitzung ist beendet. Melde dich erneut an, um weiterzuarbeiten.','the notice of every other end');
  const choice=find(entry.tree,node=>node.props?.onStart);assert.ok(choice,'Sign in with Microsoft');assert.equal(choice.props.focus,true,'Sign in with Microsoft takes the focus');
  const microsoft=find(choice.type(choice.props),node=>node.props?.className==='sd-session-primary');assert.equal(microsoft.props.variant,'primary','Sign in with Microsoft is the primary action');assert.equal(microsoft.props.autoFocus,true);
  assert.equal(find(entry.tree,node=>node.props?.id==='identity-username').props.value,'','no username for an Entra account');
  assert.equal(find(entry.tree,node=>node.props?.id==='identity-password').props.autoFocus,false,'the password field does not take the focus');
  window.location.assign=target=>navigations.push(target);choice.props.onStart();assert.deepEqual(navigations,['/api/auth/entra/start'],'it starts the normal sign-in with Microsoft (entraStartPath)');delete window.location.assign;
  // The session gate has no remembered browser and no Continue with Microsoft any more.
  for(const gone of ['EntraSessionExpired','session.remember','session.rememberedBrowser','remember24',"action:'resume'",'session.entraContinue','session.signInWithPassword'])assert.ok(!gateSource.includes(gone),`SessionGate has no ${gone}`);
  assert.equal(load('ui/session/identity-entry.tsx').entraErrorKey('staleSignIn'),'entra.error.staleSignIn','#entra=staleSignIn shows the staleSignIn text');}
 console.log('Local identity UI: 18 component/transport scenarios passed.');
}finally{disposeAll();}
