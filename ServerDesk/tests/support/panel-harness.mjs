// Runs a device panel of app/ with deterministic hook cells, the way tests/ui/devices/diagnostics-workspace.mjs
// does: the panel files named in `hooked` run their useState/useRef/useEffect on numbered cells, so a
// test calls the panel function, reads the element tree and invokes its handlers; the kit parts they
// render (DataTable, Drawer, Kpi, Menu, Notice, Skeleton) render with React SSR. Radix portals render
// in place, so open drawers and menus show in the markup. sonner records its toasts.
// Used by tests/ui/devices/device-services.mjs, device-updates.mjs, device-network-panel.mjs, device-system.mjs,
// storage-panel-view.mjs, storage-focus-view.mjs and the panel tests of the later device-view slices.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import * as radix from 'radix-ui';
import {renderToStaticMarkup} from 'react-dom/server';
import {i18nRequire,localeHooks,translateModule} from './i18n-stubs.mjs';

const require=createRequire(import.meta.url),root=process.cwd();
const inline=({children})=>children;
const radixInline={...radix,Dialog:{...radix.Dialog,Portal:inline},AlertDialog:{...radix.AlertDialog,Portal:inline},DropdownMenu:{...radix.DropdownMenu,Portal:inline}};
const realLocale=await import('../../lib/i18n/locale.ts');
const englishT=(key,params)=>translateModule.translate('en',key,params);
const englishHooks={...localeHooks,useLocale:()=>['en',()=>{}],useT:()=>englishT,useStableT:()=>englishT};
const hookIds=new Set(['@/ui/base/locale']);
const localeIds=new Set(['@/lib/i18n/locale','./i18n/locale','../i18n/locale','../../i18n/locale']);
// The console clock (ui/base/clock-store.ts): the panels read the shared store's current time (or the time their
// now prop pins) without hooks and without a subscription, so no interval runs and no hook cell moves. A test moves
// the time with consoleClock.set.
const clockFile=path.resolve('ui/base/clock-store.ts'),realClock=await import('../../ui/base/clock-store.ts');
const clockNow=()=>realClock.consoleClock.now();
const clockModule={...realClock,useClockValue:select=>select(clockNow()),useClockAt:()=>clockNow(),useClockTransition:()=>clockNow(),useClockNow:pinned=>pinned??clockNow()};
const isElement=value=>!!value&&typeof value==='object'&&'type' in value&&'props' in value;

/**
 * A harness for the panel files in `hooked`. stubs maps a require id to a module (or to a function
 * of the harness that returns one). locale 'en' renders the English UI; the default is German.
 * layoutEffects runs useLayoutEffect on the effect cells like useEffect (off by default: it does nothing).
 */
export function panelHarness({hooked,stubs={},locale='de',layoutEffects=false}){
 const hookedFiles=new Set(hooked.map(file=>path.resolve(file))),cache=new Map();
 const h={states:new Map(),refs:new Map(),effects:new Map(),callbacks:new Map(),pending:[],stateIndex:0,refIndex:0,effectIndex:0,callbackIndex:0,idIndex:0,toasts:[],toastCalls:[]};
 function effect(callback,deps){const index=h.effectIndex++,previous=h.effects.get(index);if(!previous||!deps||deps.some((value,i)=>!Object.is(value,previous.deps?.[i]))){previous?.cleanup?.();h.effects.set(index,{callback,deps});h.pending.push(index);}}
 const react={...React,
  useState(initial){const index=h.stateIndex++;if(!h.states.has(index))h.states.set(index,typeof initial==='function'?initial():initial);return [h.states.get(index),next=>h.states.set(index,typeof next==='function'?next(h.states.get(index)):next)];},
  useRef(initial){const index=h.refIndex++;if(!h.refs.has(index))h.refs.set(index,{current:initial});return h.refs.get(index);},
  useEffect:effect,
  useLayoutEffect(callback,deps){if(layoutEffects)effect(callback,deps);},
  /** Like React: the same function while the deps are equal, so an effect that depends on it does not run again. */
  useCallback(callback,deps){const index=h.callbackIndex++,previous=h.callbacks.get(index);if(previous&&deps&&previous.deps&&deps.length===previous.deps.length&&deps.every((value,i)=>Object.is(value,previous.deps[i])))return previous.callback;h.callbacks.set(index,{callback,deps});return callback;},
  useMemo(callback){return callback();},
  /** A stable id per call position, like React's useId. */
  useId(){return 'h'+(h.idIndex++);},
  /** The store's current snapshot; the harness renders on demand, so it needs no subscription. */
  useSyncExternalStore(_subscribe,getSnapshot){return getSnapshot();},
 };
 // toasts holds the texts (errors and infos with a prefix); toastCalls also the options (duration, action).
 const toast={success:(text,options)=>{h.toasts.push(text);h.toastCalls.push({type:'success',text,options});},error:(text,options)=>{h.toasts.push('error:'+text);h.toastCalls.push({type:'error',text,options});},info:(text,options)=>{h.toasts.push('info:'+text);h.toastCalls.push({type:'info',text,options});}};
 function load(filename){
  const absolute=path.resolve(filename);if(absolute===clockFile)return clockModule;if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};if(absolute.endsWith('.json')){const value=JSON.parse(fs.readFileSync(absolute,'utf8'));cache.set(absolute,{exports:value});return value;}
  const mod={exports:{}};cache.set(absolute,mod);
  const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{fileName:absolute,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  function localRequire(id){
   if(Object.hasOwn(stubs,id))return typeof stubs[id]==='function'?stubs[id](api):stubs[id];
   if(locale==='en'&&hookIds.has(id))return englishHooks;
   if(locale==='en'&&localeIds.has(id))return realLocale;
   const i18n=i18nRequire(id);if(i18n)return i18n;
   if(id==='react')return hookedFiles.has(absolute)?react:React;
   if(id==='radix-ui')return radixInline;
   if(id==='sonner')return {toast};
   if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx',base+'.js'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());if(file)return file.endsWith(".mjs")?require(file):load(file);}
   return require(id);
  }
  new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
 }
 /** Every element of a tree: children and element props (toolbar, actions, primary, footer, action, empty.action) and the cells of every DataTable row. */
 function walk(node,result=[]){
  if(Array.isArray(node)){for(const item of node)walk(item,result);return result;}
  if(!isElement(node))return result;
  result.push(node);
  for(const [key,value] of Object.entries(node.props)){
   if(key==='columns'||key==='rows')continue;
   if(isElement(value)||Array.isArray(value))walk(value,result);
   else if(key==='empty'&&value)walk(value.action,result);
   else if(key==='items'&&Array.isArray(value))for(const item of value)walk(item?.value,result);
  }
  if(Array.isArray(node.props.columns)&&Array.isArray(node.props.rows))for(const row of node.props.rows)for(const column of node.props.columns)walk(column.cell(row),result);
  return result;
 }
 const text=element=>walk(element).flatMap(item=>React.Children.toArray(item.props.children).filter(child=>typeof child==='string'||typeof child==='number')).join(' ');
 const find=(element,predicate)=>walk(element).find(predicate);
 const api={
  h,load,walk,text,find,
  get toasts(){return h.toasts;},
  get toastCalls(){return h.toastCalls;},
  /** Fresh cells; states seeds cells by index. */
  reset(states={}){for(const effect of h.effects.values())effect.cleanup?.();h.states=new Map(Object.entries(states).map(([index,value])=>[Number(index),value]));h.refs=new Map();h.effects=new Map();h.callbacks=new Map();h.pending=[];h.toasts=[];h.toastCalls=[];},
  /** Calls the panel with fresh hook indices and returns its element tree. */
  tree(Panel,props){h.stateIndex=0;h.refIndex=0;h.effectIndex=0;h.callbackIndex=0;h.idIndex=0;return Panel(props);},
  html(Panel,props){return renderToStaticMarkup(api.tree(Panel,props));},
  /** Runs the effects that the last renders scheduled, then lets their promises settle. */
  async flush(){for(const index of h.pending.splice(0)){const effect=h.effects.get(index);if(effect)effect.cleanup=effect.callback();}await api.settle();},
  async settle(){for(let index=0;index<12;index++)await Promise.resolve();},
  /** A control with this aria-label, else a kit part with this label prop (IconBtn, Menu, Kpi). */
  labelled(element,label){return find(element,item=>item.props['aria-label']===label)??find(element,item=>item.props.label===label&&!Array.isArray(item.props.columns));},
  /** The element with an onClick whose own text is label (Btn and native buttons). */
  button(element,label){return find(element,item=>item.props.onClick&&text(item).trim()===label);},
  /** The DataTable with this label. */
  table(element,label){return find(element,item=>Array.isArray(item.props.columns)&&(label===undefined||item.props.label===label));},
  /** The entries of the Menu with this label. */
  menu(element,label){return find(element,item=>Array.isArray(item.props.entries)&&item.props.label===label)?.props.entries;},
 };
 return api;
}
