// Runs the components of the page Add device (ui/devices/add-device/add-device.tsx,
// add-device-installers.tsx, portal-certificate-card.tsx) with deterministic hooks:
// effects run after each render pass, setState during a render renders again,
// timers are fake. Only the components named in `expand` render inline (they
// share the hook slots of the mounted component); kit parts stay elements whose
// props a test reads. Used by tests/ui/devices/add-device-page.mjs,
// tests/ui/devices/add-device-installers.mjs and tests/api/portal-certificate.mjs.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {i18nRequire} from './i18n-stubs.mjs';
import {germanLocale,germanLocalePath} from './locale-de.mjs';

const nodeRequire=createRequire(import.meta.url),root=process.cwd();
const sameDeps=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
let active=null;
const hooks={...React,
 useState(initial){const owner=active,index=owner.cursor++;if(!(index in owner.slots))owner.slots[index]={value:typeof initial==='function'?initial():initial};const slot=owner.slots[index];return [slot.value,next=>{const value=typeof next==='function'?next(slot.value):next;if(!Object.is(value,slot.value)){slot.value=value;owner.dirty=true;}}];},
 useRef(initial){const owner=active,index=owner.cursor++;owner.slots[index]??={current:initial};return owner.slots[index];},
 useEffect(fn,deps){const owner=active,index=owner.cursor++,previous=owner.slots[index];if(previous&&deps&&sameDeps(previous.deps,deps))return;owner.pending.push({index,fn,deps});},
 useId(){return 'id';},
 useMemo(fn,deps){const owner=active,index=owner.cursor++,previous=owner.slots[index];if(previous&&deps&&sameDeps(previous.deps,deps))return previous.value;owner.slots[index]={deps,value:fn()};return owner.slots[index].value;},
 useCallback(fn,deps){return hooks.useMemo(()=>fn,deps);},
 // The console clock (clock-store.ts): its current snapshot, without a subscription.
 useSyncExternalStore(_subscribe,getSnapshot){return getSnapshot();},
};
hooks.useLayoutEffect=hooks.useEffect;

// Fake timers: setTimeout and setInterval run only through advance().
export const clock={now:0,timers:new Map(),next:0};
export function advance(ms){
 const until=clock.now+ms;
 for(;;){
  const due=[...clock.timers.entries()].filter(([,timer])=>timer.due<=until).sort((a,b)=>a[1].due-b[1].due)[0];
  if(!due)break;
  const [id,timer]=due;clock.now=timer.due;
  if(timer.every)timer.due+=timer.every;else clock.timers.delete(id);
  timer.callback();
 }
 clock.now=until;
}
globalThis.setTimeout=(callback,ms=0)=>{const id=++clock.next;clock.timers.set(id,{callback,due:clock.now+ms});return id;};
globalThis.clearTimeout=id=>{clock.timers.delete(id);};
globalThis.setInterval=(callback,ms)=>{const id=++clock.next;clock.timers.set(id,{callback,due:clock.now+ms,every:ms});return id;};
globalThis.clearInterval=id=>{clock.timers.delete(id);};
export const intervals=()=>[...clock.timers.values()].filter(timer=>timer.every).map(timer=>timer.every);

const named=new Proxy({},{get:(_target,key)=>key==='__esModule'?false:String(key)});
/** Loads an app file with transpiled TypeScript; stubs maps import ids (as written) or repository paths to modules. */
export function loader(stubs={}){
 const cache=new Map();
 const load=filename=>{
  const absolute=path.resolve(filename);
  if(absolute===germanLocalePath)return germanLocale;
  if(cache.has(absolute))return cache.get(absolute).exports;
  if(absolute.endsWith('.css'))return {};
  const mod={exports:{}};cache.set(absolute,mod);
  const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const localRequire=id=>{
   if(Object.hasOwn(stubs,id))return stubs[id];
   const stub=i18nRequire(id);if(stub)return stub;
   if(id==='react')return hooks;
   if(id==='lucide-react')return named;
   if(id.startsWith('.')||id.startsWith('@/')){
    const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id);
    const relative=path.relative(root,base).split(path.sep).join('/');
    if(Object.hasOwn(stubs,relative))return stubs[relative];
    const file=[base,base+'.ts',base+'.tsx',base+'.js'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());
    if(file)return load(file);
   }
   return nodeRequire(id);
  };
  new Function('require','module','exports',code)(localRequire,mod,mod.exports);
  return mod.exports;
 };
 return load;
}

export const isElement=value=>!!value&&typeof value==='object'&&'type' in value&&'props' in value;
/** Every element in the tree, also elements in props (Steps items, Drawer footer, DataTable empty). */
export function nodes(node){
 if(Array.isArray(node))return node.flatMap(nodes);
 if(!isElement(node))return node&&typeof node==='object'&&!(node instanceof Date)?Object.values(node).flatMap(value=>isElement(value)||Array.isArray(value)?nodes(value):[]):[];
 return [node,...Object.entries(node.props).flatMap(([,value])=>isElement(value)?nodes(value):Array.isArray(value)?value.flatMap(item=>isElement(item)||Array.isArray(item)?nodes(item):item&&typeof item==='object'?nodes(item):[]):value&&typeof value==='object'&&!(value instanceof Date)&&!('current' in value)?nodes(value):[])];
}
/** The text of an element: its children, then the elements in its other props (Steps items, a Notice action). */
export function text(node){
 if(node==null||typeof node==='boolean')return '';
 if(typeof node!=='object')return String(node);
 if(Array.isArray(node))return node.map(text).join('');
 if(!isElement(node))return 'children' in node?text(node.children):'';
 const extra=Object.entries(node.props).filter(([key])=>key!=='children').map(([,value])=>isElement(value)?text(value):Array.isArray(value)?value.map(item=>isElement(item)||item&&typeof item==='object'&&'children' in item?text(item):'').join(''):'').join('');
 return text(node.props.children)+extra;
}

/** Mounts a component; expand names the function components that render inline. */
export function mount(Component,props,{expand=[]}={}){
 const owner={slots:{},cursor:0,pending:[],dirty:false,props,tree:null,disposed:false};
 const inline=new Set(expand);
 const walk=node=>{
  if(Array.isArray(node))return node.map(walk);
  if(!isElement(node)){
   if(node&&typeof node==='object'&&!(node instanceof Date)&&'children' in node)return {...node,children:walk(node.children)};
   return node;
  }
  if(typeof node.type==='function'&&inline.has(node.type.name))return walk(node.type(node.props));
  const next={};
  for(const [key,value] of Object.entries(node.props))next[key]=isElement(value)||Array.isArray(value)?walk(value):value;
  return {...node,props:next};
 };
 const runEffects=()=>{
  for(const effect of owner.pending){const previous=owner.slots[effect.index];previous?.cleanup?.();owner.slots[effect.index]={deps:effect.deps,cleanup:effect.fn()};}
  owner.pending=[];
 };
 const render=()=>{
  if(owner.disposed)return owner.tree;
  let rounds=0;
  do{
   owner.dirty=false;owner.cursor=0;owner.pending=[];active=owner;
   try{owner.tree=walk(Component(owner.props));}finally{active=null;}
   runEffects();
   if(rounds++>20)throw Error('The component does not settle');
  }while(owner.dirty);
  return owner.tree;
 };
 render();
 const ui={
  get tree(){return owner.tree;},
  render,
  setProps(change){owner.props={...owner.props,...change};render();},
  async settle(){for(let round=0;round<40;round++){await new Promise(resolve=>setImmediate(resolve));if(owner.dirty)render();}},
  dispose(){owner.disposed=true;for(const slot of Object.values(owner.slots))slot?.cleanup?.();},
  all:predicate=>nodes(owner.tree).filter(predicate),
  find:predicate=>nodes(owner.tree).find(predicate),
  text:node=>text(node??owner.tree),
 };
 return ui;
}
