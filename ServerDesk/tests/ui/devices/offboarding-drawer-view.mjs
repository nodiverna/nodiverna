// The offboarding drawer and the device notice of a removal with agent
// uninstall (ui/devices/device/offboarding.tsx). The component runs with a small
// hook runner and fake timers: rows, states, summary, agent message codes,
// polling, a failed load and the footer actions.
import '../../support/register.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nRequire,de} from '../../support/i18n-stubs.mjs';
const agentMessages=await import('../../../lib/agent-messages.ts'),offboarding=await import('../../../lib/offboarding.ts');
const {removalNeedsStepUp}=await import('../../../ui/devices/device/device-removal.tsx');
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};

const code=ts.transpileModule(fs.readFileSync('ui/devices/device/offboarding.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
function harness(initial){
 const cells=[],effects=[],timers=new Map(),micro=[];let cursor=0,dirty=false,tree,nextTimer=0;
 const hooks={
  useState(value){const index=cursor++;cells[index]??={value};const cell=cells[index];return [cell.value,next=>{const resolved=typeof next==='function'?next(cell.value):next;if(!Object.is(resolved,cell.value)){cell.value=resolved;dirty=true;}}];},
  useRef(value){const index=cursor++;cells[index]??={ref:{current:value}};return cells[index].ref;},
  useEffect(fn,deps){const index=cursor++,cell=cells[index]??={};cells[index]=cell;const changed=!deps||!cell.deps||deps.length!==cell.deps.length||deps.some((dep,k)=>!Object.is(dep,cell.deps[k]));if(changed){cell.deps=deps;effects.push(()=>{cell.cleanup?.();const cleanup=fn();cell.cleanup=typeof cleanup==='function'?cleanup:undefined;});}},
 };
 const jsx=(type,props)=>({type,props:props??{}}),mod={exports:{}};
 const modules={'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'lucide-react':new Proxy({},{get:(_target,key)=>String(key)}),'@/lib/agent-messages':agentMessages,'@/lib/offboarding':offboarding,'@/ui/kit/kit':{Btn:'Btn',Drawer:'Drawer',Notice:'Notice',StatusPill:'StatusPill'}};
 const require=id=>i18nRequire(id)??(Object.hasOwn(modules,id)?modules[id]:(()=>{throw Error('Unexpected import '+id);})());
 new Function('require','module','exports','setTimeout','clearTimeout','queueMicrotask',code)(require,mod,mod.exports,(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},id=>timers.delete(id),fn=>micro.push(fn));
 const props={ids:[],open:true,servers:[],demo:false,saving:false,load:async()=>[],onAction:()=>{},onRemoved:()=>{},onClose:()=>{},...initial};
 const Component=mod.exports.default;
 function render(){let limit=0;do{dirty=false;cursor=0;tree=Component(props);for(const effect of effects.splice(0))effect();if(limit++>10)throw Error('Unstable render');}while(dirty);}
 async function settle(){for(let n=0;n<20;n++){await new Promise(resolve=>setImmediate(resolve));while(micro.length)micro.shift()();if(dirty)render();}}
 const children=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(children):[node,...Object.values(node.props??{}).flatMap(value=>Array.isArray(value)||value&&typeof value==='object'&&'type' in value?children(value):[])];
 const text=node=>Array.isArray(node)?node.map(text).join(''):typeof node==='string'||typeof node==='number'?String(node):node&&typeof node==='object'?[node.props?.children].flat(Infinity).map(text).join(''):'';
 const all=()=>children(tree);
 const button=label=>all().find(node=>node.type==='Btn'&&text(node)===label);
 render();
 return {props,timers,render,settle,all,button,text:()=>all().map(node=>typeof node.props.children==='string'?node.props.children:'').join(' '),tree:()=>tree,pills:()=>all().filter(node=>node.type==='StatusPill').map(node=>[node.props.kind,text(node)])};
}
const capable={protocolVersion:3,agentCapabilities:['agent-uninstall']};
const id=n=>`00000000-0000-4000-8000-0000000000${String(n).padStart(2,'0')}`;
const rows=[
 {id:id(1),name:'SRV-DONE',state:'uninstalled',jobId:'j1'},
 {id:id(2),name:'SRV-PLAIN',state:'revoked'},
 {id:id(3),name:'SRV-WAIT',state:'waiting',jobId:'j3'},
 {id:id(4),name:'SRV-RUN',state:'running',jobId:'j4'},
 {id:id(5),name:'SRV-AGENT',state:'failed',reason:'agent',code:'AGENT_UNINSTALL_TERMINAL_ACTIVE',args:null,result:'A terminal or Remote Desktop session is open. Close it and try again.',jobId:'j5'},
 {id:id(6),name:'SRV-OLD',state:'failed',reason:'unsupported'},
 {id:id(7),name:'SRV-REG',state:'registered'},
];
const servers=[{id:id(5),name:'SRV-AGENT',snapshot:capable},{id:id(6),name:'SRV-OLD',snapshot:{protocolVersion:3,agentCapabilities:[]}},{id:id(7),name:'SRV-REG',snapshot:capable}];

// Rows, status texts with their pills, and the summary.
{
 const loads=[],removed=[];
 const ui=harness({ids:rows.map(row=>row.id),servers,load:async ids=>{loads.push(ids);return rows;},onRemoved:ids=>removed.push(ids)});
 await ui.settle();
 check(loads,[rows.map(row=>row.id)],'the drawer loads the batch on open');
 const drawer=ui.tree();check([drawer.type,drawer.props.title],['Drawer',de('console.offboarding.title')],'a kit Drawer with its title');
 check(ui.pills(),[['success',de('console.offboarding.state.uninstalled')],['neutral',de('console.offboarding.state.revoked')],['waiting',de('console.offboarding.state.waiting')],['maintenance',de('console.offboarding.state.running')],['critical',de('console.offboarding.state.failed')],['critical',de('console.offboarding.state.failed')],['warning',de('console.offboarding.state.registered')]],'one StatusPill with text per row');
 const summary=drawer.props.description;
 check([summary.props['aria-live'],summary.props.children],['polite',de('console.offboarding.summary',{uninstalled:1,revoked:1,open:5})],'the summary counts uninstalled, only revoked and still open');
 const names=ui.all().filter(node=>node.type==='strong').map(node=>node.props.children);check(names,rows.map(row=>row.name),'every device of the batch is listed');
 const reasons=ui.all().filter(node=>node.type==='small').map(node=>node.props.children);
 check(reasons,[de('agentMessage.AGENT_UNINSTALL_TERMINAL_ACTIVE'),de('console.offboarding.reason.unsupported')],'an agent failure shows agentMessage.<code>, other failures their reason');
 check(removed,[[id(1),id(2)]],'rows that left the portal go to the console once');
 ui.render();await ui.settle();check(removed.length,1,'no second report for the same rows');
 // Polling every 5 s while a row is waiting, running or registered.
 const [timer]=[...ui.timers.values()];check([ui.timers.size,timer?.ms],[1,5000],'one 5-second poll is scheduled');
 timer.fn();ui.timers.clear();ui.render();await ui.settle();
 check(loads.length,2,'the poll loads again');
}

// Polling stops when every row is final; closing stops it too.
{
 let answer=[{id:id(3),name:'SRV-WAIT',state:'waiting'}];const loads=[];
 const ui=harness({ids:[id(3)],load:async()=>{loads.push(1);return answer;}});await ui.settle();
 check(ui.timers.size,1,'a waiting row keeps polling');
 answer=[{id:id(3),name:'SRV-WAIT',state:'uninstalled'}];
 const [[timerId,timer]]=[...ui.timers.entries()];ui.timers.delete(timerId);timer.fn();ui.render();await ui.settle();
 check([loads.length,ui.timers.size],[2,0],'all rows final: no further poll');
 const again=harness({ids:[id(3)],load:async()=>[{id:id(3),name:'SRV-WAIT',state:'running'}]});await again.settle();check(again.timers.size,1,'a running row polls');
 again.props.open=false;again.render();await again.settle();check(again.timers.size,0,'closing the drawer stops polling');
}

// A failed load shows the danger notice with a retry and keeps the rows.
{
 let fail=false;const loads=[];
 const ui=harness({ids:[id(3)],load:async()=>{loads.push(1);if(fail)throw new Error('offline');return [{id:id(3),name:'SRV-WAIT',state:'waiting'}];}});await ui.settle();
 fail=true;const [[timerId,timer]]=[...ui.timers.entries()];ui.timers.delete(timerId);timer.fn();ui.render();await ui.settle();
 const notice=ui.all().find(node=>node.type==='Notice');
 check([notice?.props.tone,notice?.props.children],['danger',de('console.offboarding.loadFailed')],'a failed load shows the danger notice');
 check(ui.all().filter(node=>node.type==='strong').map(node=>node.props.children),['SRV-WAIT'],'the rows loaded before stay');
 fail=false;const reload=ui.all().find(node=>node.type==='Btn'&&node.props.children===de('console.offboarding.reload'));reload.props.onClick();ui.render();await ui.settle();
 check([loads.length,!!ui.all().find(node=>node.type==='Notice')],[3,false],'the retry reloads and clears the notice');
}

// Footer: remove without uninstalling and try again, through the step-up flow.
{
 const actions=[];
 const ui=harness({ids:rows.map(row=>row.id),servers,load:async()=>rows,onAction:payload=>{actions.push(payload);}});await ui.settle();
 const remove=ui.button(de('console.offboarding.removeWithout')),retry=ui.button(de('common.retry'));
 check([remove.props.variant,remove.props.blocked,retry.props.blocked],['danger',undefined,undefined],'both actions are available for open rows');
 remove.props.onClick();retry.props.onClick();
 check(actions,[{action:'remove-servers',ids:[id(5),id(6),id(7)],confirm:true},{action:'remove-servers',ids:[id(5),id(7)],confirm:true,uninstall:true}],'remove sends the open rows without uninstall, try again the capable ones with uninstall');
 check(actions.map(removalNeedsStepUp),[true,true],'both payloads enter the step-up flow');
 // The loading state follows the console's saving flag; the end of saving reloads the rows.
 ui.props.saving=true;ui.render();check([ui.button(de('common.retry')).props.loading,ui.button(de('console.offboarding.removeWithout')).props.loading],[true,false],'the clicked action shows its loading state');
 let reloaded=0;ui.props.load=async()=>{reloaded++;return rows.map(row=>row.state==='failed'||row.state==='registered'?{...row,state:'revoked'}:row);};ui.props.saving=false;ui.render();await ui.settle();
 check([reloaded,ui.button(de('common.retry'))],[1,undefined],'after the action the drawer refreshes; no open rows, no footer');
 // A single open row sends remove-server; no capable open row blocks "Try again" with its reason.
 const single=harness({ids:[id(6)],servers,load:async()=>[rows[5]],onAction:payload=>actions.push(payload)});await single.settle();
 check(single.button(de('common.retry')).props.blocked,de('console.offboarding.retryBlocked'),'try again is blocked without a capable open row');
 single.button(de('console.offboarding.removeWithout')).props.onClick();check(actions.at(-1),{action:'remove-server',id:id(6),confirm:true},'one device: remove-server');
 const demo=harness({ids:[id(7)],servers,demo:true,load:async()=>[rows[6]]});await demo.settle();
 check([demo.button(de('common.retry')).props.blocked,demo.button(de('console.offboarding.removeWithout')).props.blocked],[de('kit.unavailable.demo'),de('kit.unavailable.demo')],'demo mode blocks both actions');
}

// The device notice from the console's job list.
{
 const mod={exports:{}};
 const modules={'react':{useEffect(){},useRef:value=>({current:value}),useState:value=>[value,()=>{}]},'react/jsx-runtime':{jsx:()=>null,jsxs:()=>null,Fragment:'Fragment'},'lucide-react':{},'@/lib/agent-messages':agentMessages,'@/lib/offboarding':offboarding,'@/ui/kit/kit':{}};
 new Function('require','module','exports',code)(name=>i18nRequire(name)??modules[name],mod,mod.exports);
 const {deviceUninstallNotice,offboardingPayload,offboardingSummary}=mod.exports,now=Date.now(),t=(key,params)=>de(key,params);
 const server={id:id(9),snapshot:capable},job=extra=>({id:'job',serverId:id(9),action:'agent-uninstall',target:'',createdAt:now-1000,claimedAt:null,result:null,actor:'owner',...extra});
 check(deviceUninstallNotice(server,[],now,t),null,'no uninstall job: no notice');
 check(deviceUninstallNotice(server,[job({state:'pending'})],now,t),{tone:'warning',text:de('device.uninstall.pending')},'a pending job: waiting for the agent');
 check(deviceUninstallNotice(server,[job({state:'running',claimedAt:now})],now,t),{tone:'warning',text:de('device.uninstall.pending')},'a running job: waiting for the agent');
 check(deviceUninstallNotice(server,[job({state:'failed',result:'A file transfer is in progress. Try again when it is complete.',resultCode:'AGENT_UNINSTALL_TRANSFER_ACTIVE'})],now,t),{tone:'danger',text:de('device.uninstall.failed'),reason:de('agentMessage.AGENT_UNINSTALL_TRANSFER_ACTIVE')},'a failed job: uninstall failed with its reason');
 check(deviceUninstallNotice(server,[job({state:'pending',createdAt:now-6*60_000})],now,t)?.reason,de('console.offboarding.reason.offline'),'a pending job past its lifetime: failed, offline');
 check(deviceUninstallNotice(server,[job({state:'cancelled',result:'Agent unterstützt die Deinstallation nicht'})],now,t)?.reason,de('console.offboarding.reason.unsupported'),'the capability cancellation: unsupported');
 check(deviceUninstallNotice(server,[job({id:'old',state:'failed',createdAt:now-9000}),job({id:'new',state:'pending'})],now,t)?.tone,'warning','the latest job decides');
 check(deviceUninstallNotice(server,[job({state:'failed',result:'Disk error'})],now,t)?.reason,de('console.offboarding.reason.agentFallback',{message:'Disk error'}),'an agent failure without a code shows the stored text');
 check([offboardingPayload([id(1)],false),offboardingPayload([id(1),id(2)],true)],[{action:'remove-server',id:id(1),confirm:true},{action:'remove-servers',ids:[id(1),id(2)],confirm:true,uninstall:true}],'the action payloads');
 check(offboardingSummary(rows),{uninstalled:1,revoked:1,open:5},'the summary counts');
}
// The device page and the console wire the notice and the drawer.
{
 const device=fs.readFileSync('ui/devices/device/device.tsx','utf8'),consoleText=fs.readFileSync('ui/shell/console.tsx','utf8');
 check(/<Notice tone=\{uninstall\.tone\} icon=\{PackageX\} action=\{onShowOffboarding&&<Btn size="sm" onClick=\{onShowOffboarding\}>\{t\('console\.offboarding\.show'\)\}<\/Btn>\}>/.test(device),true,'the device notice offers "Show offboarding"');
 check(/const uninstall=canOffboard\?deviceUninstallNotice\(server,jobs,now,t\):null;/.test(device),true,'only an Owner sees the notice, from the console job list');
 check(/<OffboardingDrawer key=\{offboardingIds\.join\(','\)\} ids=\{offboardingIds\} open=\{!confirmation&&!mfaOpen\}/.test(consoleText),true,'the console renders the drawer for the batch');
 check(/onUninstallRequested:ids=>setOffboardingIds\(/.test(consoleText),true,'a removal with uninstall opens the drawer');
}
console.log(`PASS offboarding drawer (${checks} assertions): rows, status pills, summary, agent message codes, polling and its stop, a failed load with retry, remove without uninstall and try again through the step-up flow, and the device notice.`);
