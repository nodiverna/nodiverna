// Render the real diagnostics panels with explicit loading/result states.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url),cache=new Map(),root=process.cwd();
let stateIndex=0,states=new Map();
const react={...React,useState(initial){const index=stateIndex++;return [states.has(index)?states.get(index):typeof initial==='function'?initial():initial,()=>{}];}};
function load(filename){
  const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;
  if(absolute.endsWith('.css'))return {};
  const mod={exports:{}};cache.set(absolute,mod);
  const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{fileName:absolute,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  function localRequire(id){
    if(id==='react')return react;
    if(id==='@/ui/session/mfa-step-up')return {MfaStepUp:()=>null};
    // A plain JavaScript module of runtime/ (for example runtime/release-version.mjs) loads as itself.
    if(id.startsWith('.')&&id.endsWith('.mjs'))return require(path.resolve(path.dirname(absolute),id));
    if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx',base+'.js'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());if(file)return load(file);}
    return require(id);
  }
  new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const {SessionPanel,ConnectionsPanel}=load('ui/devices/diagnostics/diagnostics-panels.tsx');
const at=Date.now(),props={viewer:{id:'owner',label:'Owner',permissions:['*']},demo:false,server:{id:'device',name:'WIN-TEST',management:1,lastSeen:at,revoked:0,snapshot:{protocolVersion:3,mode:'Management',agentCapabilities:['list-sessions','list-connections','message-session','disconnect-session','logoff-session','network-diagnostics']}}};
const job=(kind,state='succeeded',data={},changes={})=>({id:kind,kind,state,createdAt:at,claimedAt:null,result:null,data:{kind,at:new Date(at).toISOString(),data},...changes});
const render=(Panel,{jobs,loaded=true,loading=false,error='',errorKind='list-sessions',autoStarted=true,autoPreparing=false,busyKind=null,submitted=null,...overrides}={})=>{
  stateIndex=0;states=new Map();
  if(jobs){states.set(0,{serverId:'device',jobs,loaded});states.set(1,{serverId:'device',error,source:error?'query':null,kind:errorKind,params:{}});states.set(2,{serverId:'device',loading,busyKind,autoStarted,autoPreparing,submitted});}
  return renderToStaticMarkup(React.createElement(Panel,{...props,...overrides}));
};
// The element tree a panel returns with the same hook cells (captured inside a render): every element, element props and the cells of each DataTable row.
const isElement=value=>!!value&&typeof value==='object'&&'type' in value&&'props' in value;
const elements=(node,result=[])=>{
  if(Array.isArray(node)){for(const item of node)elements(item,result);return result;}
  if(!isElement(node))return result;
  result.push(node);
  for(const [key,value] of Object.entries(node.props))if(key!=='columns'&&key!=='rows'&&(isElement(value)||Array.isArray(value)))elements(value,result);
  if(Array.isArray(node.props.columns)&&Array.isArray(node.props.rows))for(const row of node.props.rows)for(const column of node.props.columns)elements(column.cell(row),result);
  return result;
};
const tree=(Panel,options={})=>{render(Panel,options);stateIndex=0;const hookKeys=['jobs','loaded','loading','error','errorKind','autoStarted','autoPreparing','busyKind','submitted'],overrides=Object.fromEntries(Object.entries(options).filter(([key])=>!hookKeys.includes(key)));let built;renderToStaticMarkup(React.createElement(()=>{built=Panel({...props,...overrides});return built;}));return elements(built);};
let html=render(SessionPanel);
assert.match(html,/Sitzungen werden geladen/);assert.match(html,/sdx-skeleton-table/);
assert.ok(!html.includes('Keine angemeldeten Benutzer'),'initial unknown sessions are not rendered as empty');
assert.ok(!html.includes('Sitzungen abfragen.'));

html=render(ConnectionsPanel);
assert.match(html,/Verbindungen werden geladen/);assert.ok(!html.includes('Keine Verbindungen im Ergebnis'));
for(const removed of ['Verbindungssnapshot','Traffic wird pro Netzwerkadapter','Noch keine Abfrage'])assert.ok(!html.includes(removed));

const events=job('query-events');
html=render(SessionPanel,{jobs:[events]});assert.ok(!html.includes('Ereignisse ·'));
html=render(ConnectionsPanel,{jobs:[events]});assert.ok(!html.includes('Ereignisse ·'));
const failed=job('list-sessions','failed',{}, {result:'WTS-Abfrage fehlgeschlagen',data:null});
html=render(SessionPanel,{jobs:[events,failed]});assert.match(html,/Sitzungen · Fehlgeschlagen/);assert.match(html,/WTS-Abfrage fehlgeschlagen/);
// A coded agent result shows the catalog text in the UI language, not the English fallback.
const coded=job('list-sessions','failed',{}, {result:'The user session changed in the meantime. Refresh the sessions.',resultCode:'AGENT_SESSION_CHANGED',resultArgs:{},data:null});
html=render(SessionPanel,{jobs:[events,coded]});assert.match(html,/Die Benutzersitzung hat sich inzwischen geändert\. Aktualisiere die Sitzungen\./);assert.ok(!html.includes('The user session changed'),'the English fallback is not shown for a known code');

html=render(SessionPanel,{jobs:[job('list-sessions','succeeded',{sessions:[]})]});assert.match(html,/Keine angemeldeten Benutzer im Ergebnis/);
html=render(SessionPanel,{jobs:[job('list-sessions','succeeded',{})]});assert.ok(!html.includes('Keine angemeldeten Benutzer im Ergebnis'),'missing array does not invent an empty result');
const saved=job('list-sessions','succeeded',{sessions:[{sessionId:2,username:'DOMAIN\\Niko',state:'Active',station:'RDP-Tcp',idleSeconds:0}]});
html=render(SessionPanel,{jobs:[job('list-sessions','running',{}, {id:'new',data:null}),saved]});
assert.match(html,/DOMAIN\\Niko/,'a refresh keeps the loaded rows');assert.ok(!html.includes('sdx-skeleton'),'a refresh never blanks loaded rows');
assert.match(html,/role="region" aria-label="Sitzungen"[^>]*aria-busy="true"/,'the table is marked busy while the newer query runs');
assert.match(html,/<button[^>]*aria-busy="true"[^>]*>/,'the refresh action shows loading');
const rowMenus=tree(SessionPanel,{jobs:[job('list-sessions','running',{}, {id:'new',data:null}),saved]}).filter(node=>Array.isArray(node.props.entries));
assert.equal(rowMenus.length,1,'one row menu per session');
assert.deepEqual(rowMenus[0].props.entries.map(entry=>[entry.label,entry.blocked]),[['Nachricht senden','Warte, bis die Sitzungsliste aktualisiert ist.'],['Sitzung trennen','Warte, bis die Sitzungsliste aktualisiert ist.'],['Benutzer abmelden','Warte, bis die Sitzungsliste aktualisiert ist.']],'session mutations stay blocked during refresh and say why');
const idleMenus=tree(SessionPanel,{jobs:[saved]}).filter(node=>Array.isArray(node.props.entries));
assert.deepEqual(idleMenus[0].props.entries.map(entry=>entry.blocked),[undefined,undefined,undefined],'after the refresh the entries are available again');
const busyMenus=tree(SessionPanel,{jobs:[saved],busyKind:'message-session'}).filter(node=>Array.isArray(node.props.entries));
assert.ok(busyMenus[0].props.entries.every(entry=>entry.blocked==='Eine andere Anfrage läuft. Warte, bis sie abgeschlossen ist.'),'while another session action runs the entries say why');

html=render(SessionPanel,{jobs:[],server:{...props.server,lastSeen:at-180000}});
assert.match(html,/Gerät offline/);assert.ok(!html.includes('Sitzungen werden geladen'));
html=render(SessionPanel,{jobs:[],server:{...props.server,snapshot:{...props.server.snapshot,agentCapabilities:[]}}});
assert.match(html,/Der Agent auf diesem Gerät ist dafür zu alt/);assert.ok(!html.includes('Sitzungen werden geladen'));
html=render(SessionPanel,{jobs:[],error:'Anfrage wurde abgelehnt.'});assert.match(html,/sdx-notice-danger[^>]*role="alert"/);assert.match(html,/Anfrage wurde abgelehnt/);assert.match(html,/Erneut versuchen/);
html=render(SessionPanel,{viewer:{...props.viewer,permissions:[]},server:{...props.server,permissions:[]}});assert.match(html,/Dir fehlt die Berechtigung, auf diesem Gerät Diagnosen auszuführen\./);assert.ok(!html.includes('zugewiesenen Rechte'));assert.ok(!html.includes('Aktualisieren'));

const network=job('network-diagnostics','failed',{}, {result:'Ziel nicht erreichbar',data:null});
const connection=job('list-connections','succeeded',{connections:[]});
html=render(ConnectionsPanel,{jobs:[events,network,connection]});assert.match(html,/Verbindungen · Abgeschlossen/);assert.match(html,/Netzwerkdiagnose · Fehlgeschlagen/);assert.match(html,/Ziel nicht erreichbar/);assert.ok(!html.includes('Ereignisse ·'));
html=render(ConnectionsPanel,{jobs:[job('list-connections','succeeded',{})]});assert.ok(!html.includes('Keine Verbindungen im Ergebnis'),'missing connection output does not invent an empty result');
console.log('PASS: truthful diagnostics loading, cached-session refresh, empty-vs-missing results, disabled/offline/unsupported controls, relevant job status and redundant connection text removed.');
