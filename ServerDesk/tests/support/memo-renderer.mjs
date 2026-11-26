// A small React renderer for render-count tests: it runs the real components of ui/ (real React elements, real
// React.memo, real hooks through React's own hook dispatcher) without a DOM, and keeps a fiber per element so that
// state updates, store subscriptions (useSyncExternalStore) and new props render again only what React would render
// again: a component whose element is the same object, or a memoized component whose props pass its compare (the
// shallow compare by default), is skipped unless its own state, a store it reads or a context it reads changed.
// renders counts every call of a component function by its name. Host elements (div, tr, li, …) only pass their
// children on; refs stay null, so effects that measure the DOM do nothing. Effects run after each render pass:
// layout effects first, then the others. Used by tests/ui/shell/workspace-render-performance.mjs.
// Optional fake host nodes: memoRenderer({host}) calls host(view) for a host element with a ref; a returned object
// becomes the ref's value (object or callback ref) until the element unmounts, null keeps the ref null. view.props
// is the element's current props and view.descendants() its host descendants (each {type, props}) in tree order,
// so a fake node can derive its geometry from what renders inside it (tests/ui/kit/tabs-narrow-settles.mjs).
import React from 'react';

const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const symbols={memo:Symbol.for('react.memo'),forwardRef:Symbol.for('react.forward_ref'),fragment:Symbol.for('react.fragment'),context:Symbol.for('react.context'),consumer:Symbol.for('react.consumer'),portal:Symbol.for('react.portal'),lazy:Symbol.for('react.lazy'),strict:Symbol.for('react.strict_mode'),suspense:Symbol.for('react.suspense'),profiler:Symbol.for('react.profiler'),activity:Symbol.for('react.activity')};
const changed=(previous,next)=>!previous||!next||previous.length!==next.length||next.some((value,index)=>!Object.is(value,previous[index]));
const shallowEqual=(a,b)=>{if(Object.is(a,b))return true;const keys=Object.keys(a);if(keys.length!==Object.keys(b).length)return false;return keys.every(key=>Object.hasOwn(b,key)&&Object.is(a[key],b[key]));};
const nameOf=type=>typeof type==='string'?type:type?.$$typeof===symbols.memo?nameOf(type.type):type?.$$typeof===symbols.forwardRef?(type.displayName||type.render?.name||'ForwardRef'):type?.displayName||type?.name||'Anonymous';

export function memoRenderer({host=null}={}){
 const renders=new Map(),pendingEffects=[];let root=null,current=null,cursor=0,ids=0;
 const dirty=new Set();
 const contextValues=new Map();
 const readContext=context=>{const stack=contextValues.get(context);return stack?.length?stack.at(-1):context._currentValue;};
 // Runs fn with a provider's value on the context stack (a render or a skipped provider whose subtree is revisited).
 const provide=(context,value,fn)=>{const stack=contextValues.get(context)??[];contextValues.set(context,stack);stack.push(value);try{fn();}finally{stack.pop();}};
 const hook=()=>{const fiber=current;if(!fiber)throw Error('A hook ran outside a component render');const index=cursor++;return {fiber,index,cell:fiber.hooks[index]};};
 const schedule=fiber=>{if(!fiber.unmounted)dirty.add(fiber);};
 const dispatcher={
  readContext,
  use(value){if(value?.$$typeof===symbols.context)return dispatcher.useContext(value);throw Error('use() of a promise is not supported');},
  useContext(context){const fiber=current,value=readContext(context);fiber.contexts.set(context,value);return value;},
  useState(initial){return dispatcher.useReducer((state,action)=>typeof action==='function'?action(state):action,initial,value=>typeof value==='function'?value():value);},
  useReducer(reducer,initialArg,init){
   const {fiber,index,cell}=hook();
   if(cell){cell.reducer=reducer;return [cell.state,cell.dispatch];}
   const created={state:init?init(initialArg):initialArg,reducer};
   created.dispatch=action=>{const next=created.reducer(created.state,action);if(Object.is(next,created.state))return;created.state=next;schedule(fiber);};
   fiber.hooks[index]=created;return [created.state,created.dispatch];
  },
  useRef(initial){const {fiber,index,cell}=hook();return cell??(fiber.hooks[index]={current:initial});},
  useMemo(factory,deps){const {fiber,index,cell}=hook();if(cell&&deps&&!changed(cell.deps,deps))return cell.value;const value=factory();fiber.hooks[index]={deps,value};return value;},
  useCallback(callback,deps){return dispatcher.useMemo(()=>callback,deps);},
  useEffect(create,deps){effect('passive',create,deps);},
  useLayoutEffect(create,deps){effect('layout',create,deps);},
  useInsertionEffect(create,deps){effect('layout',create,deps);},
  useImperativeHandle(ref,create,deps){effect('layout',()=>{if(typeof ref==='function'){ref(create());return ()=>ref(null);}if(ref){ref.current=create();return ()=>{ref.current=null;};}},deps);},
  useSyncExternalStore(subscribe,getSnapshot){
   const {fiber,index,cell}=hook();
   const value=getSnapshot();
   if(cell){cell.getSnapshot=getSnapshot;cell.value=value;if(cell.subscribe!==subscribe){cell.unsubscribe?.();cell.subscribe=subscribe;cell.unsubscribe=subscribe(cell.listener);}return value;}
   const created={getSnapshot,value,subscribe};
   created.listener=()=>{if(!Object.is(created.getSnapshot(),created.value))schedule(fiber);};
   created.unsubscribe=subscribe(created.listener);
   fiber.hooks[index]=created;fiber.cleanups.push(()=>created.unsubscribe?.());
   return value;
  },
  useId(){const {fiber,index,cell}=hook();return cell??(fiber.hooks[index]=`:r${(ids++).toString(36)}:`);},
  useTransition(){return [false,callback=>callback()];},
  useDeferredValue(value){return value;},
  useDebugValue(){},
  useOptimistic(value){return [value,()=>{}];},
  useEffectEvent(callback){const ref=dispatcher.useRef(callback);dispatcher.useLayoutEffect(()=>{ref.current=callback;});return (...args)=>ref.current(...args);},
 };
 function effect(kind,create,deps){
  const {fiber,index,cell}=hook();
  if(cell&&deps&&!changed(cell.deps,deps))return;
  const slot=cell??{};fiber.hooks[index]=slot;slot.deps=deps;
  pendingEffects.push({kind,run:()=>{if(fiber.unmounted)return;slot.cleanup?.();const cleanup=create();slot.cleanup=typeof cleanup==='function'?cleanup:undefined;}});
  if(!cell)fiber.cleanups.push(()=>slot.cleanup?.());
 }

 const newFiber=(type,key)=>({type,key,hooks:[],children:new Map(),contexts:new Map(),cleanups:[],element:null,unmounted:false});
 const unmount=fiber=>{fiber.unmounted=true;dirty.delete(fiber);for(const child of fiber.children.values())unmount(child);for(const cleanup of fiber.cleanups)cleanup();};
 const call=(fiber,render)=>{
  const previous=current,previousCursor=cursor,previousDispatcher=internals.H;
  current=fiber;cursor=0;internals.H=dispatcher;
  try{return render();}finally{current=previous;cursor=previousCursor;internals.H=previousDispatcher;}
 };
 const count=type=>{const name=nameOf(type);renders.set(name,(renders.get(name)??0)+1);};
 // Whether a fiber read a context whose value changed since.
 const staleContext=fiber=>[...fiber.contexts].some(([context,value])=>!Object.is(readContext(context),value));

 /** Renders the children of a parent fiber: keyed by element key or position and type. */
 function reconcile(parent,children){
  const seen=new Map(),list=[];
  const flatten=(node,prefix)=>{
   if(node===null||node===undefined||typeof node==='boolean'||typeof node==='string'||typeof node==='number'||typeof node==='bigint')return;
   if(Array.isArray(node)){node.forEach((child,index)=>flatten(child,prefix+(child&&typeof child==='object'&&child.key!=null?'$'+child.key:'#'+index)+'/'));return;}
   if(typeof node==='object'&&node.$$typeof===symbols.portal){flatten(node.children,prefix+'portal/');return;}
   if(typeof node==='object'&&typeof node[Symbol.iterator]==='function'&&!('$$typeof' in node)){flatten([...node],prefix);return;}
   if(typeof node==='object'&&'type' in node&&'props' in node){list.push([prefix,node]);return;}
   throw Error('Unexpected child '+String(node));
  };
  flatten(children,'');
  for(const [path,element] of list){
   const id=path+':'+(element.key??'');
   let fiber=parent.children.get(id);
   if(fiber&&fiber.type!==element.type){unmount(fiber);fiber=undefined;}
   fiber??=newFiber(element.type,id);
   seen.set(id,fiber);
   renderFiber(fiber,element);
  }
  for(const [id,fiber] of parent.children)if(!seen.has(id))unmount(fiber);
  parent.children=seen;
 }
 /** Walks a skipped fiber's subtree for fibers that must render (own state, a store, a changed context). */
 function revisit(fiber){
  const type=fiber.element?.type,walk=()=>{for(const child of fiber.children.values())renderFiber(child,child.element);};
  if(type?.$$typeof===symbols.context)provide(type,fiber.element.props.value,walk);else walk();
 }
 function renderFiber(fiber,element){
  const old=fiber.element,type=element.type,props=element.props;
  const due=dirty.has(fiber)||staleContext(fiber);
  if(old&&!due){
   if(old===element){revisit(fiber);return;}
   if(type?.$$typeof===symbols.memo&&(type.compare??shallowEqual)(old.props,props)){fiber.element=element;revisit(fiber);return;}
  }
  dirty.delete(fiber);fiber.element=element;
  if(typeof type==='string'&&host)attachHost(fiber,props.ref);
  if(typeof type==='string'||type===symbols.fragment||type===symbols.strict||type===symbols.suspense||type===symbols.profiler||type===symbols.activity){reconcile(fiber,props.children);return;}
  if(type?.$$typeof===symbols.context){provide(type,props.value,()=>reconcile(fiber,props.children));return;}
  if(type?.$$typeof===symbols.consumer){const value=readContext(type._context);fiber.contexts.set(type._context,value);reconcile(fiber,props.children(value));return;}
  const inner=type?.$$typeof===symbols.memo?type.type:type;
  let output;
  if(inner?.$$typeof===symbols.forwardRef){count(type);output=call(fiber,()=>inner.render(props,props.ref??null));}
  else if(typeof inner==='function'){
   if(inner.prototype?.isReactComponent)throw Error('Class components are not supported: '+nameOf(inner));
   count(type);fiber.contexts=new Map();output=call(fiber,()=>inner(props));
  }
  else if(inner?.$$typeof===symbols.memo){output=React.createElement(inner,props);}
  else throw Error('Unsupported element type '+String(type?.$$typeof??type));
  reconcile(fiber,output);
 }
 /** Host descendants of a fiber in tree order, as {type, props}. */
 function hostDescendants(fiber){const list=[];const walk=node=>{for(const child of node.children.values()){if(typeof child.element?.type==='string')list.push({type:child.element.type,props:child.element.props});walk(child);}};walk(fiber);return list;}
 /** Gives a host element's ref the fake node of host(view) (created once per fiber); the ref is cleared on unmount. */
 function attachHost(fiber,ref){
  if(fiber.hostRef===ref)return;
  const detach=fiber.hostDetach;fiber.hostRef=ref;fiber.hostDetach=undefined;detach?.();
  if(!ref)return;
  if(fiber.hostNode===undefined)fiber.hostNode=host({get type(){return fiber.element.type;},get props(){return fiber.element.props;},descendants:()=>hostDescendants(fiber)})??null;
  const node=fiber.hostNode;
  if(!node)return;
  if(typeof ref==='function'){const cleanup=ref(node);fiber.hostDetach=()=>typeof cleanup==='function'?cleanup():ref(null);}
  else{ref.current=node;fiber.hostDetach=()=>{if(ref.current===node)ref.current=null;};}
  if(!fiber.hostCleanup){fiber.hostCleanup=true;fiber.cleanups.push(()=>{const detach=fiber.hostDetach;fiber.hostDetach=undefined;detach?.();});}
 }
 function runEffects(){
  for(const kind of ['layout','passive']){
   const batch=pendingEffects.filter(item=>item.kind===kind);
   for(const item of batch){pendingEffects.splice(pendingEffects.indexOf(item),1);item.run();}
  }
 }
 const api={
  /** Mounts or updates the root element and renders what changed. */
  render(element){root??=newFiber(null,'root');reconcile(root,element);runEffects();return api;},
  /** Renders the fibers whose state, store or context changed, until nothing is left (effects that set state included). */
  async flush(){
   for(let round=0;round<50;round++){
    await new Promise(resolve=>setImmediate(resolve));
    if(!dirty.size&&!pendingEffects.length)return;
    if(dirty.size)revisit(root);
    runEffects();
   }
   throw Error('The tree does not settle');
  },
  /** How often each component (by name) rendered since the last reset. */
  renders:name=>renders.get(name)??0,
  resetRenders(){renders.clear();},
  /** Every mounted element in tree order: components and host elements with their current props. */
  elements(){const list=[];const walk=fiber=>{for(const child of fiber.children.values()){if(child.element)list.push(child.element);walk(child);}};if(root)walk(root);return list;},
  unmount(){if(root)unmount(root);root=null;},
 };
 return api;
}
