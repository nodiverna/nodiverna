// Never-connected devices show when their registration expires in the redesign
// device list (table and cards), and the page Add device states the 7-day rule.
// Renders the real FleetView; unrelated panels are boundaries.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {de} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map();
let layout='table';
// The layout is local UI state; the shim lets the same render show cards.
const react={...React,useState:initial=>React.useState(initial==='table'?layout:initial)};
const empty=()=>null,asDefault=component=>({__esModule:true,default:component});
function load(filename){
 const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 const mod={exports:{}};cache.set(absolute,mod);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){
  if(id==='react')return react;
  if(id==='sonner')return {toast:{error(){},success(){}}};
  if(id==='@/ui/devices/fleet/fleet-agent-updates')return {FleetAgentUpdates:({children})=>children,FleetAgentUpdateToolbar:empty,FleetAgentUpdateCell:empty};
  if(id==='@/ui/devices/history/history'||id==='@/ui/devices/fleet/fleet-export')return asDefault(empty);
  if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}
  return require(id);
 }
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const {default:FleetView}=load('ui/devices/fleet/fleet.tsx');
const now=Date.parse('2026-10-19T08:00:00.000Z'),future=now+3*86400000;
// FleetView, its rows and DeviceCard read the console clock (ui/base/clock-store.ts); it stands at now.
load('ui/base/clock-store.ts').consoleClock.set(now);
const device=(id,name,registration)=>({id,name,createdAt:now-86400000,lastSeen:null,revoked:0,management:0,snapshot:null,permissions:['view'],...(registration?{registration}:{})});
const servers=[device('a','NEW-01',{expiresAt:future}),device('b','OLD-01',{expiresAt:now-1}),device('c','LEGACY-01',{expiresAt:null}),{...device('d','LIVE-01'),lastSeen:now-30000}];
const viewer={id:'owner',label:'owner@example.test',permissions:['*']};
const noop=()=>{};
const render=(changes={})=>renderToStaticMarkup(React.createElement(FleetView,{header:null,servers,scoped:servers,groupEmpty:false,viewer,demo:false,saving:false,now,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,...changes}));
const valid='Registrierung gültig bis '+new Date(future).toLocaleString('de-DE');
const block=(html,name,tag)=>{const parts=[...html.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`,'g'))].map(match=>match[1]);const found=parts.find(part=>part.includes(`<strong>${name}</strong>`));assert.ok(found,`${name} is rendered`);return found;};
for(const mode of ['table','cards']){
 layout=mode;const html=render(),tag=mode==='table'?'tr':'article';
 assert.match(block(html,'NEW-01',tag),new RegExp(`<small class="sdx-seen-note">${valid}</small>`),`${mode}: future registration deadline`);
 assert.match(block(html,'OLD-01',tag),/<small class="sdx-seen-note">Registrierung abgelaufen<\/small>/,`${mode}: expired registration`);
 assert.match(block(html,'OLD-01',tag),/Registrierung abgelaufen<\/span>/,`${mode}: status pill names the expired registration`);
 assert.match(block(html,'NEW-01',tag),/Erste Meldung ausstehend<\/span>/,`${mode}: a valid registration keeps the waiting label`);
 assert.match(block(html,'LEGACY-01',tag),/<small class="sdx-seen-note">Registrierung ohne Ablauf<\/small>/,`${mode}: registration without expiry`);
 assert.doesNotMatch(block(html,'LIVE-01',tag),/Registrierung/,`${mode}: connected devices carry no registration note`);
}
// Rights lost: tab 'permissions' without a permissions element shows the device table and no permissions segment.
layout='table';
const fallback=render({tab:'permissions',permissions:undefined});
assert.doesNotMatch(fallback,/Berechtigungen/,'no permissions segment without the permissions element');
assert.match(fallback,/<table class="sdx-table sdx-data-table sdx-table-sticky-actions sdx-table-fixed" style="min-width:calc\(var\(--sd-col-check\) \+ var\(--sd-col-device-min\) [^"]*\)">/,'the device table is rendered');assert.match(fallback,/<strong>NEW-01<\/strong>/,'with the devices');
assert.match(render({tab:'permissions',permissions:React.createElement('section',{'data-editor':true})}),/<span>Konfiguration<\/span>[\s\S]*data-editor/,'with the element the Configuration tab and the editor show');
const addDevice=fs.readFileSync('ui/devices/add-device/add-device.tsx','utf8'),rule='Installiere den Agent innerhalb von 7 Tagen. Danach funktioniert die Registrierungsdatei nicht mehr.';
assert.ok(addDevice.includes("t('addDevice.validity')")&&de('addDevice.validity')===rule,'step 1 of Add device states the 7-day rule below the fields');
console.log('PASS: registration deadlines, expired and legacy registrations in the redesign table and cards, the 7-day rule on the page Add device, and the devices fallback of the permissions tab.');
