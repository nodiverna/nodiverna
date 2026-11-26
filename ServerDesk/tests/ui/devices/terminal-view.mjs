// Render the real terminal panel without browser/Windows device side effects.
import {serverText} from '../../support/server-text.mjs';
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {de,i18nRequire} from '../../support/i18n-stubs.mjs';
import {buttons} from '../../support/blocked-buttons.mjs';
const require=createRequire(import.meta.url),cache=new Map(),root=process.cwd();
function load(filename){
  const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;
  const mod={exports:{}};cache.set(absolute,mod);
  const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  function localRequire(id){const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;
    if(id.endsWith('.css'))return {};
    if(id==='@/ui/session/mfa-step-up')return {MfaStepUp:()=>null};
    if(id.startsWith('.')||id.startsWith('@/')){
      const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id);
      const file=[base,base+'.ts',base+'.tsx',base+'.js'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());
      if(file)return load(file);
    }
    return require(id);
  }
  new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const Terminal=load('ui/devices/remote/terminal-panel.tsx').default;
const props={viewer:{id:'owner',label:'Owner',permissions:['*']},demo:false,server:{id:'device',name:'WIN-TEST',management:1,lastSeen:Date.now(),snapshot:{protocolVersion:3,agentCapabilities:['terminal','terminal-multi','terminal-live']}}};
const ssr=(changes={})=>renderToStaticMarkup(React.createElement(Terminal,{...props,...changes}));
const html=ssr();
assert.match(html,/PowerShell/);assert.match(html,/WIN-TEST · SYSTEM/);
// no classic panel; SectionHead with the hidden title "PowerShell", the shell line as description, the pill and Connect.
assert.ok(!/class="panel|panel-heading|v3-disconnected|v3-terminal-session/.test(html),'no .panel, .panel-heading, classic lines or session rows');
assert.match(html,/^<section class="v3-terminal-panel" aria-labelledby="sd-terminal-title"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="sd-terminal-title" class="sr-only">PowerShell<\/h2><p>[^<]*WIN-TEST · SYSTEM<\/p><\/div><div class="sdx-section-head-actions"><span role="status" class="sd-terminal-state"><span class="sdx-pill sdx-pill-neutral">/,'the head: hidden title, description, status pill, then Connect');
assert.match(html,/Sitzungen werden geladen/,'a session roster starts in a truthful loading state');
assert.match(html,/sdx-skeleton-table/,'the roster loads with the kit Skeleton (table)');
assert.ok(!html.includes('Keine aktive Terminalsitzung'),'an empty roster is not shown before discovery completes');
assert.match(html,/Ctrl\+C/);assert.match(html,/Auswahl kopieren/);assert.match(html,/Einfügen/);
for(const removed of ['MFA bestätigen','Anzeige leeren','Getrennte Shells','Maximale Laufzeit bis','Ausführung unter SYSTEM.','Jede Person arbeitet in einer eigenen Shell.','Eigene Sitzung öffnen','Bereit'])assert.ok(!html.includes(removed),removed+' is absent');
assert.ok(!/<button[^>]*>[^<]*Sitzungen/.test(html),'a manual session refresh action is absent');
// One primary Connect, the status pill, input blocked until connected.
// The visible text of a button, without the sr-only description of a blocked one.
const visible=button=>button.inner.replace(/<span[^>]*class="sr-only"[^>]*>[^<]*<\/span>/g,'').replace(/<[^>]+>/g,'').trim();
const shown=buttons(html),named=label=>shown.find(button=>visible(button)===label);
assert.ok(named('Verbinden'),'the head has Connect');assert.match(named('Verbinden').attributes,/sdx-btn-primary/,'Connect is the one primary action');
assert.equal(shown.filter(button=>/sdx-btn-primary/.test(button.attributes)).length,1,'exactly one primary button');
assert.match(html,/class="sdx-pill sdx-pill-neutral"><i aria-hidden="true"><\/i>Nicht verbunden<\/span>/,'the status pill says "Not connected" (neutral)');
for(const label of ['Einfügen','Ctrl+C']){assert.equal(named(label).blocked,true,label+' is blocked while not connected');assert.equal(named(label).description,'Verbinde dich zuerst.',label+' says why');}
assert.equal(named('Auswahl kopieren').blocked,false,'copy stays available');
// Offline: Connect stays visible and says why.
const offline=buttons(ssr({server:{...props.server,lastSeen:Date.now()-600000}})).find(button=>visible(button)==='Verbinden');
assert.equal(offline.blocked,true,'offline: Connect is blocked');assert.equal(offline.description,de('management.blocked.offline'),'with "Dafür muss das Gerät online sein."');
// The concrete reason instead of the generic note.
assert.ok(ssr({server:{...props.server,management:0}}).includes('Schalte direkt auf dem Gerät den Verwaltungsmodus ein, um das zu nutzen.'),'Management mode off: the mode sentence');
assert.ok(ssr({demo:true}).includes('Bei Beispielgeräten nicht möglich.'),'demo: the demo sentence');
const noRight=ssr({viewer:{id:'reader',label:'Reader',permissions:[]},server:{...props.server,permissions:['diagnose']}});
assert.ok(noRight.includes('Dir fehlt die Berechtigung, auf diesem Gerät ein Terminal zu öffnen.'),'without the terminal right: the right sentence');
for(const markup of [ssr({demo:true}),noRight,ssr({server:{...props.server,management:0}})])assert.ok(!markup.includes('zugewiesenen Rechte')&&!markup.includes('Freie PowerShell'),'no generic note and no separate Management note');

// Opening a SYSTEM shell needs a fresh step-up proof. The panel runs
// with deterministic hook cells; the API, timers and browser globals are stubs.
const codes=await import('../../../lib/errors/codes.ts'),stepUpRetry=await import('../../../ui/session/step-up-retry.ts'),terminalInput=await import('../../../ui/devices/remote/terminal-input.ts'),unavailable=await import('../../../ui/devices/device/device-unavailable.ts');
function harness({get,post,list,initialSessions=[],online=true}){
  const cells=[],effects=[],calls=[],toasts=[];let cursor=0,dirty=false,tree;
  const hooks={useState(initial){const index=cursor++;cells[index]??={value:initial};return[cells[index].value,value=>{const next=typeof value==='function'?value(cells[index].value):value;if(!Object.is(next,cells[index].value)){cells[index].value=next;dirty=true;}}];},useRef(initial){const index=cursor++;cells[index]??={value:{current:initial}};return cells[index].value;},useCallback(fn,deps){const index=cursor++,old=cells[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))cells[index]={deps,value:fn};return cells[index].value;},useEffect(fn,deps){const index=cursor++,old=cells[index];if(!old||!deps||deps.some((value,i)=>!Object.is(value,old.deps[i])))effects.push(()=>{old?.cleanup?.();cells[index]={deps,cleanup:fn()};});}};
  class ApiError extends Error{constructor(text,status,code){super(text);this.status=status;this.code=code;}}
  const api=async(url,payload)=>{calls.push({url,payload:payload&&JSON.parse(JSON.stringify(payload))});if(payload)return post(payload,ApiError);if(url.includes('&id=')&&!url.includes('&after='))return get(url,ApiError);if(!url.includes('&'))return list?list(ApiError):{sessions:initialSessions,activeSessions:initialSessions.map(item=>({...item,isOwn:true,canClose:true})),multiuser:true,maxSessions:4};return {frames:[],state:'open'};};
  const jsx=(type,props)=>({type,props:props??{}}),mod={exports:{}},noop=()=>{};
  const discovery={createTerminalSessionRequest:request=>({promise:Promise.resolve().then(()=>request(new AbortController().signal)),abort:noop}),createTerminalSessionDiscovery:({refresh})=>({start:()=>void refresh(),request:()=>void refresh(),stop:noop})};
  const shared={api,credentialFetch:async()=>({}),message:error=>error.message,stamp:value=>String(value),permitted:()=>true,online:()=>online,v3:()=>true,ApiError};
  const toast={success:text=>toasts.push(text),error:text=>toasts.push('error:'+text),info:text=>toasts.push('info:'+text)};
  const kit={Btn:'Btn',Notice:'Notice',Skeleton:'Skeleton',StatusPill:'StatusPill',Unavailable:'Unavailable',Menu:'Menu',SectionHead:'SectionHead'};
  const require=id=>i18nRequire(id)??(id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({}, {get:(_object,key)=>String(key)}):id==='sonner'?{toast}:id==='@/ui/kit/kit'?kit:id==='@/ui/kit/confirm-dialog'?{ConfirmDialog:'ConfirmDialog'}:id==='@/ui/kit/data-table'?{DataTable:'DataTable'}:id==='@/ui/devices/device/device-unavailable'?unavailable:id==='@/ui/base/api'?shared:id==='@/ui/session/mfa-step-up'?{MfaStepUp:'MfaStepUp'}:id==='@/lib/errors/codes'?codes:id==='@/ui/session/step-up-retry'?stepUpRetry:id==='@/ui/devices/remote/terminal-input'?terminalInput:id==='@/ui/devices/remote/terminal-session-discovery'?discovery:id==='@/ui/devices/remote/terminal-theme'?{terminalTheme:()=>({})}:id.endsWith('.css')?{}:(()=>{throw Error('Unexpected '+id);})());
  const code=ts.transpileModule(fs.readFileSync('ui/devices/remote/terminal-panel.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const browser={addEventListener:noop,removeEventListener:noop,dispatchEvent:noop,visibilityState:'visible'};
  new Function('require','module','exports','window','document','navigator','setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame','ResizeObserver',code)(require,mod,mod.exports,browser,browser,{onLine:true},()=>0,noop,()=>0,noop,()=>0,noop,class{observe(){}disconnect(){}});
  const server={id:'device',name:'WIN-TEST',management:1,lastSeen:Date.now(),snapshot:{protocolVersion:3,agentCapabilities:['terminal','terminal-multi','terminal-live']}};
  // Children, the action of a Notice, the actions and primary of the SectionHead and the cells of the sessions DataTable.
  const tableCells=node=>Array.isArray(node.props?.columns)&&Array.isArray(node.props?.rows)?node.props.rows.flatMap(row=>node.props.columns.map(column=>column.cell(row))):[];
  function nodes(node){if(arguments.length===0)node=tree;if(!node||typeof node!=='object')return[];return[node,...[node.props?.children,node.props?.action,node.props?.actions,node.props?.primary,...tableCells(node)].flat(Infinity).flatMap(child=>nodes(child))];}
  const text=node=>[node?.props?.children].flat(Infinity).map(child=>typeof child==='string'||typeof child==='number'?child:child&&typeof child==='object'?text(child):'').join('');
  function render(){let limit=0;do{dirty=false;cursor=0;tree=mod.exports.default({...props,server});for(const effect of effects.splice(0))effect();if(limit++>8)throw Error('Unstable render');}while(dirty);}
  async function settle(predicate){for(let n=0;n<60;n++){await new Promise(resolve=>setImmediate(resolve));if(dirty)render();if(predicate())return;}throw Error('State did not settle');}
  // A Btn by its text, else a row Menu entry of the sessions table by its label (pressed through onClick like a button).
  const menuEntry=label=>nodes().filter(node=>node.type==='Menu').flatMap(node=>node.props.entries).find(entry=>entry.label?.includes(label));
  const find=predicate=>nodes().find(predicate),button=label=>find(node=>node.type==='Btn'&&text(node).includes(label))??(entry=>entry&&{props:{onClick:entry.onSelect,blocked:entry.blocked,danger:entry.danger,menu:true}})(menuEntry(label)),dialog=()=>find(node=>node.type==='MfaStepUp').props;
  const posted=()=>calls.filter(call=>call.payload).map(call=>call.payload);
  const lines=()=>nodes().filter(node=>node.type==='Notice'&&['warning','danger'].includes(node.props.tone)&&!node.props.action);
  render();return {calls,toasts,posted,render,settle,find,button,dialog,lines,all:()=>nodes(),text:()=>nodes().map(text).join(' ')};
}
// Opening the subarea with your own running shell only reads the session list.
{
  const ui=harness({initialSessions:[{id:'session-own',state:'open',createdAt:1}],get:()=>{throw Error('no resume before Connect');},post:()=>{throw Error('no POST before Connect');}});
  await ui.settle(()=>!!ui.button('Fortsetzen'));for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(ui.calls.map(call=>[call.url,!!call.payload]),[['/api/terminal?serverId=device',false]],'only the session-list GET goes out');
  assert.equal(ui.dialog().open,false,'no step-up dialog before Connect');
  assert.equal(ui.find(node=>node.type==='StatusPill').props.kind,'neutral');assert.equal(ui.text().includes('Nicht verbunden'),true,'status: not connected');
  // Connect resumes your own running shell instead of opening a second one.
  let resumed=0;const resume=harness({initialSessions:[{id:'session-own',state:'open',createdAt:1}],get:()=>{resumed++;return {session:{id:'session-own',state:'open'},state:'open',inputSeq:0,ack:0};},post:()=>({ok:true})});
  await resume.settle(()=>!!resume.button('Fortsetzen'));
  resume.button('Verbinden').props.onClick();await resume.settle(()=>resumed===1&&!!resume.button('Sitzung beenden'));
  assert.equal(resume.posted().some(payload=>payload.action==='open'),false,'Connect with your own running shell resumes it');
  assert.equal(resume.button('Sitzung beenden').props.variant,undefined,'while attached the head button is "End session" (secondary)');
  assert.equal(resume.find(node=>node.type==='StatusPill').props.kind,'neutral');assert.ok(resume.text().includes('Verbindung wird aufgebaut'),'status: connecting until the first answer');
  // Offline: Connect is blocked and sends nothing.
  const away=harness({online:false,post:()=>{throw Error('no POST offline');}});await away.settle(()=>!!away.button('Verbinden'));
  assert.equal(away.button('Verbinden').props.blocked,de('management.blocked.offline'));away.button('Verbinden').props.onClick();await away.settle(()=>true);assert.equal(away.posted().length,0,'a blocked Connect sends nothing');
}
{
  let opened=false;
  const ui=harness({post:(payload,ApiError)=>{if(payload.action==='open'&&!payload.managementToken)throw new ApiError(serverText('apiError.mfa.confirmChange'),403,'MFA_STEP_UP_REQUIRED');if(payload.action==='open'){opened=true;return {id:'session-1',state:'opening',expiresAt:Date.now()+60000,ack:0,inputSeq:0,resumed:false,multiuser:true,maxSessions:4};}return {ok:true};}});
  await ui.settle(()=>!!ui.button('Verbinden'));
  assert.equal(ui.dialog().open,false,'no step-up dialog before Connect');
  ui.button('Verbinden').props.onClick();await ui.settle(()=>ui.dialog().open===true);
  const first={action:'open',serverId:'device',cols:100,rows:28,confirm:true};
  assert.deepEqual(ui.posted(),[first],'without your own shell, Connect posts open; the first open goes out without a token');
  assert.match(ui.text(),/Bestätige deine Identität, um eine SYSTEM-Shell zu öffnen\./,'the open-specific warning is shown');
  assert.deepEqual(ui.toasts,[],'an MFA code opens the dialog instead of a toast');
  // A proof without managementToken sends nothing and says so.
  ui.dialog().onVerified({});ui.render();await ui.settle(()=>ui.toasts.includes('error:'+stepUpRetry.missingProofMessage));
  assert.equal(ui.posted().length,1,'a proof without token sends nothing');
  // With the proof, open goes out once more with managementToken.
  ui.dialog().onVerified({managementToken:'proof-1'});ui.render();await ui.settle(()=>opened&&!!ui.button('Sitzung beenden'));
  assert.deepEqual(ui.posted(),[first,{...first,managementToken:'proof-1'}],'the resent open carries managementToken');
  // Closing your own shell never sends a token, also after a re-login.
  let closeNeedsLogin=true;
  const closing=harness({initialSessions:[{id:'session-2',state:'open',createdAt:1}],post:(payload,ApiError)=>{if(payload.action==='close'&&closeNeedsLogin){closeNeedsLogin=false;throw new ApiError(serverText('apiError.mfa.loginRequired'),403,'MFA_LOGIN_REQUIRED');}return {ok:true};}});
  await closing.settle(()=>!!closing.button('Fortsetzen'));
  closing.button('Sitzung beenden').props.onClick();await closing.settle(()=>closing.dialog().open===true);
  closing.dialog().onVerified({managementToken:'proof-close'});closing.render();await closing.settle(()=>closing.posted().length===2);
  assert.deepEqual(closing.posted(),[{action:'close',serverId:'device',id:'session-2'},{action:'close',serverId:'device',id:'session-2'}],'close is resent after the re-login without a token');
  // Resuming your own shell sends no token, also after a re-login.
  let resumeNeedsLogin=true;
  const resuming=harness({initialSessions:[{id:'session-3',state:'open',createdAt:1}],get:(_url,ApiError)=>{if(resumeNeedsLogin){resumeNeedsLogin=false;throw new ApiError(serverText('apiError.mfa.loginRequired'),403,'MFA_LOGIN_REQUIRED');}return {session:{id:'session-3',state:'open'},state:'open',inputSeq:0,ack:0};},post:()=>({ok:true})});
  await resuming.settle(()=>!!resuming.button('Fortsetzen'));
  resuming.button('Fortsetzen').props.onClick();await resuming.settle(()=>resuming.dialog().open===true);
  resuming.dialog().onVerified({managementToken:'proof-resume'});resuming.render();await resuming.settle(()=>resuming.calls.filter(call=>call.url.endsWith('&id=session-3')).length===2);
  assert.equal(resuming.calls.some(call=>JSON.stringify(call).includes('proof-resume')),false,'resume never sends the token');
  assert.equal(resuming.posted().some(payload=>payload.action==='open'),false,'resume does not open a new shell');
  // A failed Connect without an MFA code is a toast.
  const refused=harness({post:(payload,ApiError)=>{throw new ApiError(serverText('apiError.terminal.limitMultiuser'),409,'TERMINAL_LIMIT');}});
  await refused.settle(()=>!!refused.button('Verbinden'));refused.button('Verbinden').props.onClick();await refused.settle(()=>refused.toasts.length===1);
  assert.deepEqual(refused.toasts,['error:'+serverText('apiError.terminal.limitMultiuser')],'a refused open shows toast.error');assert.equal(refused.dialog().open,false);assert.equal(refused.lines().length,0,'and no line in the panel');
}
// A failed session list: a danger notice with "Try again" that reads the list again.
{
  let fail=true,reads=0;
  const ui=harness({post:()=>({ok:true}),list:ApiError=>{reads++;if(fail)throw new ApiError('Die Sitzungsliste ist nicht erreichbar.',503);return {sessions:[],activeSessions:[],multiuser:true,maxSessions:4};}});
  const danger=()=>ui.find(node=>node.type==='Notice'&&node.props.tone==='danger');
  await ui.settle(()=>!!danger());
  assert.ok(ui.text().includes('Die Sitzungsliste ist nicht erreichbar.'),'the notice names the error');
  assert.equal(danger().props.action.props.children,'Erneut versuchen','with "Try again"');
  assert.equal(ui.find(node=>node.type==='Skeleton'),undefined,'no skeleton next to the error');
  fail=false;danger().props.action.props.onClick();await ui.settle(()=>!!ui.find(node=>node.type==='DataTable')?.props.empty.title.includes('Keine aktive Terminalsitzung'));
  assert.equal(reads,2,'"Try again" reads the session list again');assert.equal(danger(),undefined,'the notice goes after a good read');
  assert.equal(ui.posted().length,0,'reading the list never opens a session');
}
// A sequence conflict shows the catalog text once, in the warning
// line, drops queued input, resyncs the sequence and accepts new input.
{
  const conflictText=de(codes.errorCatalog.TERMINAL_SEQUENCE_CONFLICT.key),serverText='Eingabesequenz ist nicht fortlaufend.';
  const ui=harness({
    post:(payload,ApiError)=>{
      if(payload.action==='open')return {id:'session-9',state:'opening',expiresAt:Date.now()+60000,ack:0,inputSeq:0,resumed:false,multiuser:true,maxSessions:4};
      if(payload.action==='input'&&payload.seq===1)throw new ApiError(serverText,409,'TERMINAL_SEQUENCE_CONFLICT');
      if(payload.action==='input')return {ok:true,seq:payload.seq,ack:payload.seq};
      return {ok:true};
    },
    get:()=>({session:{id:'session-9',state:'open'},state:'open',inputSeq:5,ack:4}),
  });
  await ui.settle(()=>!!ui.button('Verbinden'));
  ui.button('Verbinden').props.onClick();await ui.settle(()=>ui.button('Ctrl+C')?.props.blocked===undefined);
  ui.button('Ctrl+C').props.onClick();
  const resyncs=()=>ui.calls.filter(call=>!call.payload&&call.url.endsWith('&id=session-9'));
  await ui.settle(()=>resyncs().length===1&&ui.text().includes(conflictText));
  const shown=text=>ui.all().filter(node=>[node.props?.children].flat(Infinity).some(child=>typeof child==='string'&&child.includes(text)));
  assert.equal(shown(conflictText).length,1,'the catalog text is shown exactly once');
  assert.deepEqual([shown(conflictText)[0].type,shown(conflictText)[0].props.tone],['Notice','warning'],'in the kit warning Notice');
  assert.equal(shown(serverText).length,0,'the server text is not shown');
  assert.equal(ui.lines().length,1,'no second error line for a sequence conflict');assert.deepEqual(ui.toasts,[],'and no toast');
  assert.ok(ui.calls.findIndex(call=>call.payload?.action==='input')<ui.calls.indexOf(resyncs()[0]),'the session is read again after the conflict');
  ui.button('Ctrl+C').props.onClick();
  await ui.settle(()=>ui.posted().filter(payload=>payload.action==='input').length===2);
  assert.deepEqual(ui.posted().filter(payload=>payload.action==='input').map(payload=>payload.seq),[1,6],'new input uses the resynced inputSeq + 1');
  await ui.settle(()=>ui.text().includes('Verbunden'));
  assert.equal(ui.find(node=>node.type==='StatusPill').props.kind,'online','status: connected, the online pill (kit pulse)');
  assert.equal(ui.lines().length,1);
}
// The panel decides by code, never by message text.
assert.doesNotMatch(fs.readFileSync('ui/devices/remote/terminal-panel.tsx','utf8'),/\/MFA\|Bestätigung/);
assert.doesNotMatch(fs.readFileSync('ui/devices/remote/terminal-panel.tsx','utf8'),/@\/components\/ui\//,'the terminal imports nothing from @/components/ui/');
// "Sessions on this device" is a DataTable with one row Menu per session; ending another user's shell asks first.
{
  const roster=[{id:'own',state:'open',createdAt:1,lastActivity:5,isOwn:true,canClose:true,owner:'Owner'},{id:'other',state:'open',createdAt:2,isOwn:false,canClose:true,owner:'Anna'}];
  const ui=harness({post:()=>({ok:true}),list:()=>({sessions:[roster[0]],activeSessions:roster,multiuser:true,maxSessions:4})});
  await ui.settle(()=>!!ui.find(node=>node.type==='DataTable'));
  const table=ui.find(node=>node.type==='DataTable');
  assert.deepEqual([table.props.label,table.props.cards,table.props.columns.map(column=>column.label),table.props.foot],['Sitzungen auf diesem Gerät',true,['Konto','Geöffnet','Zuletzt aktiv','Status','Aktionen'],'2 / 4 aktiv'],'the sessions DataTable: Account (primary), Opened, Last active, State; the count is the foot');
  const sessionsHead=ui.find(node=>node.type==='SectionHead'&&node.props.title==='Sitzungen auf diesem Gerät');
  assert.deepEqual(sessionsHead&&[sessionsHead.props.level,sessionsHead.props.hideTitle],[3,undefined],'"Sessions on this device" is a kit SectionHead level 3 (a visible h3 in the kit look)');
  assert.ok(!/sd-terminal-sessions-title/.test(fs.readFileSync('ui/devices/remote/terminal-panel.tsx','utf8')+fs.readFileSync('ui/devices/remote/terminal.css','utf8')),'the hand-styled sessions title and its rule are gone');
  assert.ok(ui.text().includes('· Du'),'your own session carries the "you" mark');
  const menus=ui.all().filter(node=>node.type==='Menu');
  assert.deepEqual(menus.map(menu=>[menu.props.label,menu.props.entries.map(entry=>entry.label)]),[['Aktionen für Owner',['Fortsetzen','Sitzung beenden']],['Aktionen für Anna',['Sitzung als Admin beenden']]],'Resume and End session for your own shell, End as administrator for another one');
  assert.ok(menus.every(menu=>menu.props.entries.at(-1).danger),'ending a session is the danger entry');
  menus[1].props.entries[0].onSelect();ui.render();
  const confirm=ui.find(node=>node.type==='ConfirmDialog');
  assert.deepEqual([confirm.props.open,confirm.props.tone,confirm.props.confirmLabel],[true,'danger','Sitzung als Admin beenden'],'the existing admin ConfirmDialog opens');
  assert.equal(ui.posted().length,0,'nothing is sent before the confirmation');
  assert.doesNotMatch(fs.readFileSync('ui/devices/remote/terminal-panel.tsx','utf8'),/v3-terminal-session|className="panel|panel-heading|v3-disconnected/,'terminal-panel.tsx: no session row markup, classic panel or classic lines');
}
console.log('PASS: compact terminal structure, loading roster, essential terminal actions and removal of redundant toolbar controls; the subarea sends only the session-list GET until Connect, which resumes your own shell or opens one; open resends once with a fresh step-up proof, resume and close never send one; blocked Connect, input and reasons; action errors as toasts.');
