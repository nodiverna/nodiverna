// Drive the real setup gate, step-up dialog and account panels for passkey first
// setup and passkey-only accounts with a mocked API and WebAuthn library.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url),root=process.cwd();
const at=Date.now(),origin='https://serverdesk-console.test';
const timers=new Map();let active=null,hookIndex=0,timerId=0,now=0,network=[],replies=[],registrations=0;
// Static renders (renderToStaticMarkup) use their own module copies whose useState reads overrides by index.
const staticStates=new Map();let stateIndex=0;
const sameDeps=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
const react={...React,
 useState(initial){const index=hookIndex++,owner=active;if(!owner.hooks[index])owner.hooks[index]={value:typeof initial==='function'?initial():initial};const slot=owner.hooks[index];return [slot.value,next=>{const value=typeof next==='function'?next(slot.value):next;if(!Object.is(slot.value,value)){slot.value=value;owner.dirty=true;}}];},
 useRef(initial){const index=hookIndex++;if(!active.hooks[index])active.hooks[index]={current:initial};return active.hooks[index];},
 useMemo(fn,deps){const index=hookIndex++,previous=active.hooks[index];if(previous&&sameDeps(previous.deps,deps))return previous.value;const value=fn();active.hooks[index]={value,deps};return value;},
 useCallback(fn,deps){return react.useMemo(()=>fn,deps);},
 useEffect(fn,deps){const index=hookIndex++,previous=active.hooks[index];if(previous&&sameDeps(previous.deps,deps))return;active.hooks[index]={deps,cleanup:previous?.cleanup};active.pending.push({index,fn});},
 useSyncExternalStore(_subscribe,snapshot){hookIndex++;return snapshot();},
 // Outside React there is no provider: the context default (German) applies.
 useContext(context){return context._currentValue;},
};
const staticReact={...React,useState(initial){const index=stateIndex++;return [staticStates.has(index)?staticStates.get(index):typeof initial==='function'?initial():initial,()=>{}];}};
// The WebAuthn browser library is the boundary: the ceremony returns a fixed response.
const webauthn={startRegistration:async()=>{registrations++;return {id:'cred_new',rawId:'cred_new',type:'public-key',response:{clientDataJSON:'e30',attestationObject:'AAAA'}};},startAuthentication:async()=>{throw new Error('no authentication in this test');},WebAuthnAbortService:{cancelCeremony(){}}};
function loader(reactImpl,cache=new Map()){return function load(filename){
 const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 const source=fs.readFileSync(absolute,'utf8'),mod={exports:{}};cache.set(absolute,mod);
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){if(id==='react')return reactImpl;if(id==='@simplewebauthn/browser')return webauthn;if(id==='next/navigation')return {useRouter:()=>({refresh(){},push(){},replace(){}})};if(id==='sonner')return {toast:{success(){},error(){},info(){}}};if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}return require(id);}
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
};}
const load=loader(react),loadStatic=loader(staticReact);
// Passing the instance (not aliasing `this`) lets the hook stand-ins find their slots.
const activate=harness=>{active=harness;};
class Harness{
 constructor(component,props){this.component=component;this.props=props;this.hooks=[];this.pending=[];this.dirty=true;this.tree=null;this.render();}
 render(){activate(this);hookIndex=0;this.dirty=false;this.pending=[];this.tree=this.component(this.props);const effects=this.pending;this.pending=[];for(const effect of effects){const slot=this.hooks[effect.index];slot.cleanup?.();slot.cleanup=effect.fn();}active=null;}
 async settle(){for(let turn=0;turn<3;turn++){for(let i=0;i<40;i++){await Promise.resolve();if(this.dirty)this.render();}await new Promise(resolve=>nativeTimeout(resolve,0));}}
 dispose(){for(const slot of this.hooks)slot?.cleanup?.();}
}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const item of node){const found=find(item,predicate);if(found)return found;}return null;}if(predicate(node))return node;return find(node.props?.children,predicate);}
function text(node){if(node==null||typeof node==='boolean')return '';if(typeof node!=='object')return String(node);if(Array.isArray(node))return node.map(text).join('');return text(node.props?.children);}
// Text plus what kit parts carry in props: Field labels and hints, card titles, CopyValue values and displays.
function shown(node){if(node==null||typeof node==='boolean')return '';if(typeof node!=='object')return String(node);if(Array.isArray(node))return node.map(shown).join('');const props=node.props??{};return [props.title,props.label,props.hint,typeof props.value==='string'?props.value:'',props.display,props.children].map(shown).join('');}
function button(harness,label){const found=find(harness.tree,node=>typeof node.props?.onClick==='function'&&text(node)===label);assert.ok(found,`button ${label} exists`);return found;}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const json=(value,status=200)=>Response.json(value,{status});
const enqueue=value=>replies.push(value);
const nativeTimeout=globalThis.setTimeout,nativeClearTimeout=globalThis.clearTimeout,nativeInterval=globalThis.setInterval,nativeClearInterval=globalThis.clearInterval;
globalThis.setTimeout=(callback,ms=0)=>{const id=++timerId;timers.set(id,{callback,due:now+ms,interval:0});return id;};globalThis.clearTimeout=id=>timers.delete(id);globalThis.setInterval=(callback,ms)=>{const id=++timerId;timers.set(id,{callback,due:now+ms,interval:ms});return id;};globalThis.clearInterval=id=>timers.delete(id);
const windowTarget=new EventTarget();windowTarget.location={origin,href:origin+'/',pathname:'/'};windowTarget.top=windowTarget;windowTarget.self=windowTarget;windowTarget.isSecureContext=true;windowTarget.PublicKeyCredential=function PublicKeyCredential(){};globalThis.window=windowTarget;
const documentTarget=new EventTarget();documentTarget.visibilityState='visible';documentTarget.querySelectorAll=()=>[];globalThis.document=documentTarget;
const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{value:{credentials:{}},configurable:true});
globalThis.fetch=async(input,init={})=>{const url=new URL(input instanceof Request?input.url:String(input),origin),record={path:url.pathname,method:init.method??'GET',signal:init.signal,body:init.body?JSON.parse(init.body):undefined};network.push(record);const next=replies.shift();if(next===undefined)throw new Error('Unexpected request '+record.method+' '+record.path);if(next?.promise){if(init.signal?.aborted)throw init.signal.reason??new DOMException('Aborted','AbortError');return new Promise((resolve,reject)=>{const abort=()=>reject(init.signal.reason??new DOMException('Aborted','AbortError'));init.signal?.addEventListener('abort',abort,{once:true});next.promise.then(value=>{init.signal?.removeEventListener('abort',abort);resolve(value);},error=>{init.signal?.removeEventListener('abort',abort);reject(error);});});}return next;};
const SessionGate=load('ui/session/session-gate.tsx').default,http=load('ui/base/http.ts');
const passkeysModule=load('ui/account/passkeys-panel.tsx'),PasskeySignInOptions=passkeysModule.PasskeySignInOptions,PasskeysPanel=passkeysModule.default;
const {MfaStepUp}=load('ui/session/mfa-step-up.tsx');
// The code Field of the step-up dialog: its label names the code that the input below it takes.
const codeField=harness=>{const field=find(harness.tree,node=>node.props?.children?.props?.id==='v3-stepup'&&'label' in node.props);assert.ok(field,'the code input sits in a Field');return field;};
const viewer={id:'owner',userId:'owner',label:'owner@example.test',username:'owner',permissions:['*']};
const status=(extra={})=>({enabled:false,available:true,authenticated:false,serverTime:at,idleTimeoutMs:3600000,passkeyCount:0,sessionId:null,lastActivityAt:null,verifiedUntil:null,idleExpiresAt:null,sessionExpiresAt:null,...extra});
const signedIn={authenticated:true,sessionId:'session-one',lastActivityAt:at,verifiedUntil:at+3600000,idleExpiresAt:at+3600000,sessionExpiresAt:at+86400000};
const codes=Array.from({length:10},(_,i)=>`CODE-${i}`);
const token='a'.repeat(64);
const harnesses=[];
const mount=(component,props)=>{const harness=new Harness(component,props);harnesses.push(harness);return harness;};
const disposeAll=()=>{for(const harness of harnesses.splice(0))harness.dispose();};
function reset(){disposeAll();network=[];replies=[];timers.clear();now=0;registrations=0;}
const protectedView=React.createElement('div',{'data-test-protected':true},'Protected portal');
// The ends the gate handed over to the sign-in card (SessionGate onSessionEnded).
const sessionEnds=[];
async function gate(reply,actor=viewer){enqueue(json(reply));const harness=mount(SessionGate,{viewer:actor,onSessionEnded:end=>sessionEnds.push(end),children:protectedView});await harness.settle();return harness;}
const setupBlock=harness=>find(harness.tree,node=>node.type===PasskeySignInOptions);
const codeInput=harness=>find(harness.tree,node=>node.props?.id==='portal-mfa-code');
try{
 // The login screen names the configured idle timeout, never a fixed hour.
 for(const [idleTimeoutMs,expected] of [[300000,'Du wirst nach 5 Minuten ohne Aktivität abgemeldet.'],[900000,'Du wirst nach 15 Minuten ohne Aktivität abgemeldet.'],[2700000,'Du wirst nach 45 Minuten ohne Aktivität abgemeldet.'],[undefined,null]]){
  reset();const login=await gate(status({enabled:true,authenticatorCount:1,idleTimeoutMs}));const screen=shown(login.tree);
  assert.match(screen,/Authenticator-Code/,'the login screen is shown');
  assert.doesNotMatch(screen,/einer Stunde/,'no fixed one-hour text');
  if(expected)assert.ok(screen.includes(expected),expected);else assert.doesNotMatch(screen,/Du wirst nach/,'without a server value the sentence is left out');
 }
 // Kit controls on the gate: a Skeleton while checking, exactly one primary per
 // screen state, the code submit blocked with a reason until 6 digits, and the ghost "Abmelden".
 {
  const {Btn,Skeleton}=load('ui/kit/kit.tsx');
  const all=(node,predicate,found=[])=>{if(!node||typeof node!=='object')return found;if(Array.isArray(node)){for(const item of node)all(item,predicate,found);return found;}if(predicate(node))found.push(node);all(node.props?.children,predicate,found);return found;};
  const primaries=tree=>all(tree,node=>(node.type===Btn&&node.props.variant==='primary')||(node.type===PasskeySignInOptions&&node.props.primary)||(node.type==='a'&&String(node.props?.className).includes('sdx-btn-primary'))).length;
  reset();const checking=deferred();enqueue(checking);const gateView=mount(SessionGate,{viewer,children:protectedView});
  assert.equal(find(gateView.tree,node=>node.type===Skeleton)?.props.label,'Sitzung wird geprüft','a kit Skeleton with the existing label while checking');
  checking.resolve(json(status({enabled:true,authenticatorCount:1})));await gateView.settle();
  assert.equal(primaries(gateView.tree),1,'the code sign-in has one primary');
  const submitOf=tree=>find(tree,node=>node.type===Btn&&node.props.type==='submit');
  assert.equal(submitOf(gateView.tree).props.blocked,'Gib den 6-stelligen Code ein.','the code submit says why it waits');assert.equal(submitOf(gateView.tree).props.disabled,undefined,'no native disabled');
  codeInput(gateView).props.onChange({target:{value:'123456'}});await gateView.settle();
  assert.equal(submitOf(gateView.tree).props.blocked,undefined,'six digits release the submit');
  const signOut=button(gateView,'Abmelden');assert.equal(signOut.props.variant,'ghost','Sign out is a ghost text action');
  assert.equal(button(gateView,'Wiederherstellungscode verwenden').props.variant,'ghost','Use a recovery code is a ghost text action');
  for(const reply of [status(),status({passkeysAvailable:true}),status({enabled:true,authenticatorCount:0,passkeyCount:1,passkeysAvailable:true})]){
   reset();const screen=await gate(reply);assert.equal(primaries(screen.tree),1,`one primary on ${JSON.stringify({enabled:reply.enabled,passkeysAvailable:reply.passkeysAvailable,authenticatorCount:reply.authenticatorCount})}`);
  }
 }
 // The remembered browser is gone (docs/portal-sessions.md): no checkbox, no remembered-browser button, no resume
 // request and no remember24, also when an older server still sends rememberAvailable or rememberedUntil.
 {
  const future=at+3600000,remember=tree=>find(tree,node=>node.props?.className==='sd-session-remember'),rememberedButton=tree=>text(tree).includes('Mit gemerktem Browser anmelden');
  for(const [label,extra] of [['an old reply with rememberAvailable:true',{rememberAvailable:true,rememberedUntil:future}],['a current reply',{}]]){
   reset();let login=await gate(status({enabled:true,authenticatorCount:1,passkeyCount:1,...extra}));
   assert.deepEqual(network.map(call=>call.body?.action??call.method),['GET'],label+': no resume request on mount');
   assert.equal(remember(login.tree),null,label+': no remember checkbox at the code form');
   assert.equal(rememberedButton(login.tree),false,label+': no remembered-browser button');
   codeInput(login).props.onChange({target:{value:'123456'}});await login.settle();
   enqueue(json({ok:true,...status({enabled:true,authenticatorCount:1,passkeyCount:1,...signedIn,...extra})}));find(login.tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await login.settle();
   assert.equal(network.at(-1).body.action,'verify');assert.equal('remember24' in network.at(-1).body,false,label+': remember24 is not sent');
   reset();login=await gate(status({enabled:true,authenticatorCount:0,passkeyCount:1,...extra}));
   assert.equal(remember(find(login.tree,node=>node.type===PasskeySignInOptions)),null,label+': no remember checkbox in the passkey-only block');
   assert.equal(network.length,1,label+': passkey-only: no resume request on mount');
  }
 }
 // The setup screen offers a passkey first and the authenticator app second.
 reset();let harness=await gate(status({passkeysAvailable:true}));
 let block=setupBlock(harness);
 assert.ok(block,'the passkey block is rendered');
 assert.equal(block.props.title,'Mit Passkey einrichten');assert.equal(block.props.badge,'Empfohlen');assert.equal(block.props.divider,'oder Authenticator-App');
 assert.match(text(harness.tree),/Richte einen zweiten Anmeldeschritt ein/);
 let totp=button(harness,'Authenticator-App einrichten');assert.equal(totp.props.variant,'secondary','the authenticator app is the secondary choice');
 assert.ok(!find(harness.tree,node=>text(node)==='MFA einrichten'&&typeof node.props?.onClick==='function'),'the old label is gone');
 let options=mount(PasskeySignInOptions,block.props);
 assert.match(text(options.tree),/Mit Passkey einrichten/);assert.match(text(options.tree),/Empfohlen/);assert.match(text(options.tree),/oder Authenticator-App/);
 assert.match(text(options.tree),/Bluetooth muss auf beiden Geräten eingeschaltet sein/,'the smartphone hint is shown');
 const local=button(options,'Dieses Gerät / Windows Hello'),phone=button(options,'Smartphone / QR-Code');
 assert.equal(local.props.variant,'primary','This device is the primary of the setup card');assert.equal(local.props.blocked,undefined);assert.equal(phone.props.blocked,undefined);
 // The ceremony: busy state, then the recovery codes for the passkey.
 const pendingOptions=deferred();enqueue(pendingOptions);
 local.props.onClick();await harness.settle();
 assert.equal(network.at(-1).path,'/api/passkeys');assert.deepEqual(network.at(-1).body,{action:'setup-options',device:'local'});
 block=setupBlock(harness);assert.equal(block.props.busy,true);assert.equal(block.props.pending,'local','the clicked device shows the loading state');
 options=mount(PasskeySignInOptions,block.props);
 assert.match(text(options.tree),/Bestätige die Anfrage im Browserdialog…/);
 assert.equal(button(options,'Dieses Gerät / Windows Hello').props.loading,true,'the clicked device is a loading Btn that keeps its label');assert.ok(button(options,'Smartphone / QR-Code').props.blocked,'the other device waits with a reason');
 assert.equal(text(button(harness,'Authenticator-App einrichten')),'Authenticator-App einrichten','the authenticator button keeps its label during the passkey dialog');
 // The setup reply carries no authenticatorCount.
 enqueue(json({ok:true,...status({enabled:true,passkeyCount:1,...signedIn}),recoveryCodes:codes}));
 pendingOptions.resolve(json({challengeId:'c'.repeat(64),options:{challenge:'challenge'}}));await harness.settle();
 assert.equal(registrations,1,'the browser ceremony ran');
 assert.equal(network.at(-1).body.action,'setup-verify');assert.equal(network.at(-1).body.challengeId,'c'.repeat(64));
 assert.match(text(harness.tree),/Jeden Code kannst du einmal statt deines Passkeys verwenden\. Bewahre die Codes sicher auf\./,'the recovery screen names the passkey');
 assert.match(shown(harness.tree),/CODE-9/,'the codes sit in a CopyValue');
 {const CopyValue=load('ui/kit/kit.tsx').CopyValue,copy=find(harness.tree,node=>node.type===CopyValue);assert.equal(copy.props.value,codes.join('\n'),'one CopyValue copies all codes');assert.equal(copy.props.success,'Wiederherstellungscodes kopiert.');assert.ok(button(harness,'Codes herunterladen'),'Download codes');}
 assert.ok(!find(harness.tree,node=>node.props?.['data-test-protected']),'codes are shown before the portal opens');
 assert.equal(button(harness,'Weiter zu Nodiverna').props.variant,'primary');button(harness,'Weiter zu Nodiverna').props.onClick();await harness.settle();
 assert.ok(find(harness.tree,node=>node.props?.['data-test-protected']),'the portal opens after the codes');
 // A lock hands over to the sign-in card; the passkey-only second step after the password is the login below.
 window.dispatchEvent(new CustomEvent(http.SESSION_LOCK_EVENT,{detail:{code:'SESSION_EXPIRED'}}));await harness.settle();
 assert.ok(!find(harness.tree,node=>node.props?.['data-test-protected']),'the lock closes the portal');
 assert.equal(sessionEnds.at(-1)?.reason,'ended','the lock hands over to the sign-in card');
 // An error of the ceremony is shown with the passkey wording.
 reset();harness=await gate(status({passkeysAvailable:true}));
 enqueue(json({error:'MFA ist bereits eingerichtet. Melde dich mit deinem Passkey oder Authenticator an.'},409));
 setupBlock(harness).props.onSelect('phone');await harness.settle();
 assert.deepEqual(network.at(-1).body,{action:'setup-options',device:'phone'});
 assert.match(text(harness.tree),/MFA ist bereits eingerichtet/);assert.equal(setupBlock(harness).props.busy,false);
 // Identity loss aborts the ceremony and a late reply is ignored.
 reset();harness=await gate(status({passkeysAvailable:true}));
 const hung=deferred();enqueue(hung);setupBlock(harness).props.onSelect('local');await harness.settle();
 window.dispatchEvent(new CustomEvent(http.SESSION_LOCK_EVENT,{detail:{code:'IDENTITY_LOGIN_REQUIRED',message:'Identity lost during setup'}}));await harness.settle();
 assert.equal(network.at(-1).signal.aborted,true,'identity loss aborts the setup request');
 assert.deepEqual([sessionEnds.at(-1)?.reason,harness.tree],['ended',null],'identity loss hands over to the sign-in card and shows nothing of the session');
 hung.resolve(json({challengeId:'c'.repeat(64),options:{}}));await harness.settle();
 assert.equal(registrations,0,'no browser ceremony after the abort');assert.equal(harness.tree,null);assert.equal(setupBlock(harness),null);
 // Unmount aborts the ceremony too.
 reset();harness=await gate(status({passkeysAvailable:true}));
 const detached=deferred();enqueue(detached);setupBlock(harness).props.onSelect('local');await harness.settle();
 harness.dispose();assert.equal(network.at(-1).signal.aborted,true,'unmount aborts the setup request');
 // Without passkeysAvailable only TOTP is offered.
 reset();harness=await gate(status());
 assert.equal(setupBlock(harness),null,'no passkey block without passkeysAvailable');
 totp=button(harness,'Authenticator-App einrichten');assert.equal(totp.props.variant,'primary','the authenticator app is the primary button');
 // The TOTP path keeps its recovery text.
 reset();harness=await gate(status({passkeysAvailable:true}));
 enqueue(json({secret:'SETUPSECRET',uri:'otpauth://totp/x',expiresAt:at+600000}));button(harness,'Authenticator-App einrichten').props.onClick();await harness.settle();
 // The setup shows the QR code between the intro and the setup key; key, copy, link and restart stay.
 {
  const MfaQrCode=load('ui/session/mfa-qr-code.tsx').default,qr=find(harness.tree,node=>node.type===MfaQrCode);
  assert.ok(qr,'the setup shows the QR code');assert.deepEqual(qr.props,{uri:'otpauth://totp/x',expiresAt:at+600000},'the QR code gets the setup URI and expiry');
  const html=renderToStaticMarkup(React.createElement(loadStatic('ui/session/mfa-qr-code.tsx').default,qr.props));
  assert.ok(html.includes('class="sd-mfa-qr"')&&html.includes('Scanne den Code mit deiner Authenticator-App oder gib den Schlüssel unten ein.'),'the QR code and its caption render');
  const all=shown(harness.tree);for(const part of ['Einrichtungsschlüssel','SETUPSECRET','Authenticator öffnen','Einrichtung neu starten'])assert.ok(all.includes(part),`the setup keeps ${part}`);
  const CopyValue=load('ui/kit/kit.tsx').CopyValue,key=find(harness.tree,node=>node.type===CopyValue);assert.equal(key.props.value,'SETUPSECRET','the setup key is a CopyValue');assert.equal(key.props.success,'Einrichtungsschlüssel kopiert.','with the toast Setup key copied.');
  assert.equal(find(harness.tree,node=>node.type==='a'&&text(node)==='Authenticator öffnen').props.href,'otpauth://totp/x','the link keeps the setup URI');
  const card=find(harness.tree,node=>Array.isArray(node.props?.children)&&node.props.children.includes(qr)),order=card.props.children.flat();
  assert.ok(order.indexOf(qr)<order.findIndex(node=>node?.props?.className==='sd-session-secret'),'the QR code comes before the setup key');
 }
 codeInput(harness).props.onChange({target:{value:'123456'}});await harness.settle();
 enqueue(json({ok:true,...status({enabled:true,authenticatorCount:1,...signedIn}),recoveryCodes:codes}));find(harness.tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await harness.settle();
 assert.equal(network.at(-1).body.action,'confirm');
 assert.match(text(harness.tree),/Jeden Code kannst du einmal statt eines Codes aus deinem Authenticator verwenden\./);

 // Login without an authenticator: passkey or recovery code.
 reset();harness=await gate(status({enabled:true,authenticatorCount:0,passkeyCount:1}));
 assert.match(text(harness.tree),/Bestätige deine Anmeldung mit einem Passkey\./);
 assert.equal(codeInput(harness),null,'no code input until the recovery code is chosen');
 assert.ok(!shown(harness.tree).includes('Authenticator-Code'),'no authenticator code label');
 block=find(harness.tree,node=>node.type===PasskeySignInOptions);assert.equal(block.props.divider,'oder Wiederherstellungscode');
 assert.equal(find(block,node=>node.props?.className==='sd-session-remember'),null,'no remember option for the passkey');
 button(harness,'Wiederherstellungscode verwenden').props.onClick();await harness.settle();
 const input=codeInput(harness);assert.ok(input,'the recovery form opens');assert.equal(input.props.inputMode,'text');
 assert.match(shown(find(harness.tree,node=>node.type==='form')),/Wiederherstellungscode/);
 assert.ok(!text(harness.tree).includes('Authenticator verwenden'));
 input.props.onChange({target:{value:'AAAA-BBBB'}});await harness.settle();
 enqueue(json({ok:true,...status({enabled:true,authenticatorCount:0,passkeyCount:1,...signedIn})}));find(harness.tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await harness.settle();
 assert.equal(network.at(-1).body.action,'verify');assert.equal(network.at(-1).body.recoveryCode,'AAAA-BBBB','the recovery form sends recoveryCode');
 reset();harness=await gate(status({enabled:true,authenticatorCount:0,passkeyCount:1}));
 button(harness,'Wiederherstellungscode verwenden').props.onClick();await harness.settle();
 button(harness,'Passkey verwenden').props.onClick();await harness.settle();
 assert.equal(codeInput(harness),null,'„Passkey verwenden“ returns to the passkey choice');
 assert.ok(find(harness.tree,node=>node.type===PasskeySignInOptions));
 // Accounts with an authenticator render as before.
 reset();harness=await gate(status({enabled:true,authenticatorCount:1,passkeyCount:1}));
 assert.ok(codeInput(harness),'the authenticator code input stays');assert.match(shown(harness.tree),/Authenticator-Code/);
 assert.equal(find(harness.tree,node=>node.type===PasskeySignInOptions).props.divider,undefined);

 // Step-up without an authenticator.
 reset();const verified=[];let closed=0;
 enqueue(json({available:true,count:1,authenticatorCount:0,canManage:false,passkeys:[]}));
 harness=mount(MfaStepUp,{open:true,onClose:()=>closed++,onVerified:proof=>verified.push(proof)});await harness.settle();
 assert.equal(network.length,1,'the dialog makes one request');assert.equal(network[0].path,'/api/passkeys');assert.equal(network[0].method,'GET');
 assert.match(text(harness.tree.props.description),/Bestätige deine Anmeldung mit einem Passkey oder einem Wiederherstellungscode\./);
 assert.match(text(codeField(harness).props.label),/Wiederherstellungscode/);
 assert.ok(!text(harness.tree).includes('Authenticator verwenden'),'no authenticator toggle');
 assert.ok(!text(harness.tree).includes('Wiederherstellungscode verwenden'),'no toggle at all');
 find(harness.tree,node=>node.props?.id==='v3-stepup').props.onChange({target:{value:'CCCC-DDDD'}});await harness.settle();
 enqueue(json({ok:true,managementToken:token,managementExpiresAt:at+300000}));button(harness,'Bestätigen').props.onClick();await harness.settle();
 assert.deepEqual(network.at(-1).body,{action:'verify',recoveryCode:'CCCC-DDDD'},'submit sends recoveryCode');
 assert.equal(verified.length,1);assert.equal(closed,1);
 // An authenticator account keeps the code field and toggle.
 reset();enqueue(json({available:true,count:1,authenticatorCount:1,canManage:false,passkeys:[]}));
 harness=mount(MfaStepUp,{open:true,onClose(){},onVerified(){}});await harness.settle();
 assert.match(text(codeField(harness).props.label),/Authenticator-Code/);assert.match(text(harness.tree),/Wiederherstellungscode verwenden/);

 // The step-up dialog shows the server's reason for a refused resend
 // (`notice`) in its error slot; its own verify error replaces it.
 // The error slot is a child element here; rendering it gives the kit danger Notice (role=alert).
 const alertOf=dialog=>{const slot=find(dialog.tree,node=>node.type?.name==='StepUpError');assert.ok(slot,'the dialog has its error slot');const notice=slot.type(slot.props);return notice&&{tone:notice.props.tone,text:text(notice.props.children)};};
 assert.equal(alertOf(harness),null,'without notice there is no alert');
 const expired='Die Bestätigung ist abgelaufen oder bereits verwendet. Bitte die Identität erneut bestätigen.';
 reset();enqueue(json({available:true,count:0,authenticatorCount:1,canManage:false,passkeys:[]}));
 harness=mount(MfaStepUp,{open:true,onClose(){},onVerified(){},notice:expired});await harness.settle();
 assert.deepEqual(alertOf(harness),{tone:'danger',text:expired},'the notice shows as a danger Notice');
 find(harness.tree,node=>node.props?.id==='v3-stepup').props.onChange({target:{value:'123456'}});await harness.settle();
 enqueue(json({error:'Der Code ist ungültig. Versuche es erneut.'},400));button(harness,'Bestätigen').props.onClick();await harness.settle();
 assert.deepEqual(alertOf(harness),{tone:'danger',text:'Der Code ist ungültig. Versuche es erneut.'},'the own verify error replaces the notice');
 reset();enqueue(json({available:true,count:0,authenticatorCount:1,canManage:false,passkeys:[]}));
 harness=mount(MfaStepUp,{open:true,onClose(){},onVerified(){},notice:''});await harness.settle();
 assert.equal(alertOf(harness),null,'an empty notice shows nothing');

 // Account page: the factor rule and the authenticator state, on the row menus of the kit (blocked entries say why).
 const {SignInSecurityCard}=load('ui/account/account-panel.tsx'),{Menu}=load('ui/kit/kit.tsx');
 const first={id:'one',name:'Mein iPhone',createdAt:at,lastUsedAt:null};
 const base={enabled:true,available:true,authenticated:true,verifiedUntil:at+3600000,maximumAuthenticators:10};
 const rowEntry=(tree,name,id)=>{const menu=find(tree,node=>node.type===Menu&&node.props.label===`Aktionen für ${name}`);assert.ok(menu,`row menu of ${name}`);return menu.props.entries.find(entry=>entry.id===id);};
 const appState=tree=>text(find(tree,node=>node.props?.id==='account-authenticator-title').props.state);
 async function card(mfa){reset();enqueue(json(mfa));const mounted=mount(SignInSecurityCard,{viewer});await mounted.settle();return mounted;}
 harness=await card({...base,authenticatorCount:1,passkeyCount:1,passkeysAvailable:true,authenticators:[first]});
 assert.equal(rowEntry(harness.tree,'Mein iPhone','remove').blocked,undefined,'with a usable passkey the last authenticator can be removed');
 assert.equal(appState(harness.tree),'Aktiv');
 harness=await card({...base,authenticatorCount:1,passkeyCount:0,authenticators:[first]});
 assert.equal(rowEntry(harness.tree,'Mein iPhone','remove').blocked,'Behalte mindestens einen Passkey oder eine Authenticator-App.','without a passkey the last authenticator stays, with the reason');
 // Passkeys count only where they can be used.
 for(const passkeysAvailable of [false,undefined]){
  harness=await card({...base,authenticatorCount:1,passkeyCount:1,...(passkeysAvailable===undefined?{}:{passkeysAvailable}),authenticators:[first]});
  assert.equal(rowEntry(harness.tree,'Mein iPhone','remove').blocked,'Passkeys funktionieren unter dieser Adresse nicht. Behalte deshalb mindestens eine Authenticator-App.',`with passkeysAvailable ${passkeysAvailable} the last authenticator stays and says why`);
 }
 harness=await card({...base,authenticatorCount:2,passkeyCount:1,passkeysAvailable:false,authenticators:[first,{...first,id:'two',name:'Tablet'}]});
 assert.equal(rowEntry(harness.tree,'Mein iPhone','remove').blocked,undefined,'a second authenticator can go without usable passkeys');
 harness=await card({...base,authenticatorCount:0,passkeyCount:1,authenticators:[]});
 assert.equal(appState(harness.tree),'Nicht eingerichtet','a passkey-only account shows no active authenticator');
 // Passkeys panel: the last factor and the delete note.
 const {ConfirmDialog}=load('ui/kit/confirm-dialog.tsx');
 const record={id:'cred_one',name:'Laptop',device:'local',createdAt:at,lastUsedAt:null,backedUp:false,deviceType:'singleDevice'};
 async function panel(authenticatorCount){
  reset();enqueue(json({available:true,count:1,authenticatorCount,canManage:true,passkeys:[record]}));
  const mounted=mount(PasskeysPanel,{mfaEnabled:true,onConfirmIdentity(){},reloadKey:0});await mounted.settle();return mounted;
 }
 const removeNote=mounted=>text(find(mounted.tree,node=>node.type===ConfirmDialog).props.children);
 harness=await panel(0);
 assert.equal(rowEntry(harness.tree,'Laptop','remove').blocked,'Behalte mindestens einen Passkey oder eine Authenticator-App.','the only factor cannot be removed');
 harness=await panel(1);
 assert.equal(rowEntry(harness.tree,'Laptop','remove').blocked,undefined,'a passkey next to an authenticator can be removed');
 rowEntry(harness.tree,'Laptop','remove').onSelect();await harness.settle();
 assert.match(removeNote(harness),/Dies ist dein letzter Passkey/,'the note names the remaining authenticator');
 harness=await panel(0);
 rowEntry(harness.tree,'Laptop','remove').onSelect();await harness.settle();
 assert.ok(!removeNote(harness).includes('Dies ist dein letzter Passkey'),'no note without an authenticator');
 console.log('PASS passkey first setup view: the gate offers passkey setup before the authenticator app, passkey-only accounts sign in and step up with passkey or recovery code, and the account page keeps one factor.');
}finally{disposeAll();globalThis.setTimeout=nativeTimeout;globalThis.clearTimeout=nativeClearTimeout;globalThis.setInterval=nativeInterval;globalThis.clearInterval=nativeClearInterval;if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator;}
