// Exercise event handlers from the real FilePanel with deterministic hook,
// network and DOM adapters. No browser or deployed account is contacted.
import '../../support/register.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const flow=await import('../../../ui/devices/remote/file-transfer-flow.ts');
const unavailable=await import('../../../ui/devices/device/device-unavailable.ts');
import {accessCapabilities} from '../../support/access-capabilities.mjs';
let checks=0;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function harness({write=true,read=true,apiHandler,chunkHandler}={}){
 const cells=[],timers=new Map(),calls=[],saved=[],inputs=[],noticeLog=[];let cursor=0,dirty=false,tree,timeoutId=0,confirmations=0;
 const props={server:{id:'device-a',name:'HOST',management:1,permissions:['files.read','files.write'],snapshot:{protocolVersion:3}},viewer:{id:'owner',permissions:['*']},demo:false};
 const uploadStates=new Map();let uploadSequence=0;
 const effects=[],hooks={
  useState(initial){const index=cursor++;cells[index]??={value:typeof initial==='function'?initial():initial};return[cells[index].value,value=>{const next=typeof value==='function'?value(cells[index].value):value;if(next?.phase&&next?.name)noticeLog.push(next);if(!Object.is(next,cells[index].value)){cells[index].value=next;dirty=true;}}];},
  useRef(initial){const index=cursor++;cells[index]??={value:{current:initial}};return cells[index].value;},
  useEffect(callback,deps){const index=cursor++,previous=cells[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){effects.push(()=>{previous?.cleanup?.();cells[index]={deps,cleanup:callback()};});}},
 };
 const jsx=(type,props)=>({type,props:props??{}}),mod={exports:{}};
 class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
 const defaults=async(url,payload,signal)=>{if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');if(payload?.action==='create'){const id=payload.direction==='upload'?'transfer-upload-'+(++uploadSequence):'transfer-download';if(payload.direction==='upload')uploadStates.set(id,'uploading');return {id};}if(payload?.action==='finish'){uploadStates.set(payload.id,'completed');return {ok:true};}if(payload?.action==='cancel')return {ok:true};const id=new URL('https://site.test'+url).searchParams.get('id');return {transfers:[{id:id??'transfer-upload',direction:id==='transfer-download'?'download':'upload',path:'C:\\Temp\\report.bin',state:id?.startsWith('transfer-upload')?uploadStates.get(id):'completed',size:4,sha256:sha(new Uint8Array([1,2,3,4]))}]};};
 const shared={api:async(url,payload,signal)=>{calls.push({kind:'api',url,payload});return(apiHandler??defaults)(url,payload,signal,defaults);},credentialFetch:async(url,options)=>{calls.push({kind:'chunk',url,options});return(chunkHandler??(async()=>new Response(new Uint8Array([1,2,3,4]))))(url,options);},message:error=>error.message,permitted:(_server,_viewer,permission)=>permission==='files.read'?read:write,online:()=>true,v3:()=>true,CapabilityNote:'CapabilityNote',ApiError};
 const code=ts.transpileModule(fs.readFileSync('ui/devices/remote/file-panel.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const require=id=>i18nRequire(id)??(id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({}, {get:(_target,key)=>String(key)}):id==='@/ui/base/access-capabilities'?accessCapabilities:id==='@/ui/kit/kit'?{Unavailable:'Unavailable',Btn:'Btn',IconBtn:'IconBtn',Card:'Card'}:id==='@/ui/kit/field'?{Field:'Field',Switch:'Switch'}:id==='@/ui/kit/confirm-dialog'?{ConfirmDialog:'ConfirmDialog'}:id==='@/ui/devices/management/management-actions'?{confirmationDevice:name=>[{label:'Gerät',value:name}]}:id==='@/lib/i18n/format'?{formatBytes:(_locale,size)=>size+' B'}:id==='@/ui/devices/device/device-unavailable'?unavailable:id==='@/ui/base/api'?shared:id==='@/ui/devices/remote/file-browser'?{__esModule:true,default:'FileBrowser',fileBytes:size=>size+' B',joinRemotePath:(directory,name)=>directory.replace(/[\\/]+$/,'')+'\\'+name}:id==='@/ui/devices/remote/file-transfer-flow'?flow:id.endsWith('.css')?{}:(()=>{throw Error('Unexpected import '+id);})());
 const document={body:{appendChild(){}},createElement:()=>({click(){saved.push(this.download);},remove(){}})};
 const url={createObjectURL:()=> 'blob:test',revokeObjectURL(){}};
 const clock=(fn,ms)=>{const id=++timeoutId;timers.set(id,{fn,ms});return id;},clearClock=id=>timers.delete(id);
 new Function('require','module','exports','window','document','URL','setTimeout','clearTimeout',code)(require,mod,mod.exports,{confirm:()=>{confirmations++;return true;}},document,url,clock,clearClock);
 const Panel=mod.exports.default;
 function nodes(node){if(arguments.length===0)node=tree;if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(child=>nodes(child))];}
 function render(){let count=0;do{dirty=false;cursor=0;tree=Panel(props);for(const node of nodes())if(node.type==='input'&&node.props.ref){node.props.ref.current??={click(){inputs.push('choose');},value:''};}for(const effect of effects.splice(0))effect();if(count++>8)throw Error('Unstable mock rendering');}while(dirty);return tree;}
 const text=node=>[node?.props?.children].flat(Infinity).map(child=>typeof child==='string'||typeof child==='number'?child:child&&typeof child==='object'?text(child):'').join('');
 const find=predicate=>nodes().find(predicate),button=label=>{const node=find(node=>['Btn','IconBtn'].includes(node.type)&&(text(node)===label||node.props['aria-label']===label||node.props.label===label));assert.ok(node,'button exists: '+label);return node;};
 // Waits for the real async work (arrayBuffer, the SHA-256 digest on the thread
 // pool, response bodies) up to a wall-clock deadline, not a number of turns: a
 // slow CI runner needs more turns. It yields between checks, after the first
 // turns with a short timer, so the wait does not spin.
 async function settle(predicate=()=>!find(node=>node.type==='FileBrowser')?.props.transferBusy){const deadline=Date.now()+15_000;for(let n=0;;n++){await new Promise(resolve=>n<60?setImmediate(resolve):setTimeout(resolve,2));if(dirty)render();if(predicate())return;if(Date.now()>deadline)break;}throw Error('UI operation did not settle');}
 const file=(name='local.bin')=>({name,size:4,arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer});
 function choose(files=[file()],directory='C:\\Temp'){find(node=>node.type==='FileBrowser').props.onUpload(directory);render();find(node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files}});render();}
 // The upload asks through the kit ConfirmDialog (UI-Rework 13b): confirm it as the user would.
 function confirmUpload(){const dialog=find(node=>node.type==='ConfirmDialog'&&node.props.open);assert.ok(dialog,'Upload opens the confirmation');confirmations++;dialog.props.onConfirm();render();}
 function unmount(){for(const cell of cells)cell?.cleanup?.();}
 render();return {render,nodes,find,button,text,settle,choose,file,unmount,confirmUpload,props,calls,saved,inputs,timers,noticeLog,get confirmations(){return confirmations;}};
}
// FileBrowser's single click executes the complete download; no history UI.
let ui=harness();assert.ok(!ui.nodes().some(node=>ui.text(node).includes('Lokale Dateien & Transfers')));assert.ok(!ui.nodes().some(node=>node.type==='Btn'&&ui.text(node)==='Speichern'));assert.equal(ui.calls.length,0,'idle view does not poll transfers');checks+=3;
ui.find(node=>node.type==='FileBrowser').props.onDownload('C:\\Temp\\report.bin');ui.render();await ui.settle();assert.deepEqual(ui.saved,['report.bin']);assert.equal(ui.calls.filter(call=>call.payload?.action==='create').length,1);assert.ok(ui.calls.find(call=>call.url==='/api/transfers?id=transfer-download'),'polls exact created ID');assert.match(ui.nodes().map(ui.text).join(' '),/Download gestartet/);checks+=4;
const dismiss=[...ui.timers.values()].find(timer=>timer.ms===8000);assert.ok(dismiss);dismiss.fn();ui.render();assert.ok(!ui.find(node=>node.props?.['aria-label']==='Dateitransfer'));checks+=2;ui.unmount();
// A path without a last segment saves under the catalog fallback name, German byte-equal to before.
ui=harness({apiHandler:async(url,payload,signal,defaults)=>{const result=await defaults(url,payload,signal);return payload?result:{transfers:result.transfers.map(item=>({...item,path:'C:/Temp/'}))};}});ui.find(node=>node.type==='FileBrowser').props.onDownload('C:/Temp/');ui.render();await ui.settle();assert.deepEqual(ui.saved,['ServerDesk-Datei'],'a path that ends with a separator saves under the fallback name');checks++;ui.unmount();
// Paused upload retains the file, ID, destination and remaining batch. A stale
// toolbar callback or file-input event cannot start another operation.
let firstChunk=true;ui=harness({chunkHandler:async(_url,options)=>{if(firstChunk){firstChunk=false;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Abgebrochen','AbortError')),{once:true}));}return new Response('{}',{headers:{'Content-Type':'application/json'}});}});
ui.choose([ui.file('first.bin'),ui.file('second.bin')]);ui.button('Hochladen').props.onClick();ui.render();ui.confirmUpload();await ui.settle(()=>ui.calls.some(call=>call.kind==='chunk'));
ui.button('Pausieren').props.onClick();await ui.settle(()=>!!ui.find(node=>node.type==='Btn'&&ui.text(node)==='Fortsetzen'));
const browser=ui.find(node=>node.type==='FileBrowser');assert.equal(browser.props.transferBusy,true);assert.equal(ui.find(node=>node.type==='Switch').props.blocked,'Warte, bis die laufende Übertragung endet.','a paused upload blocks the overwrite Switch with the transfer reason');checks++;assert.equal(ui.find(node=>node.type==='input'&&node.props.type==='file').props.disabled,true);checks+=2;
const countBefore=ui.calls.length,choicesBefore=ui.inputs.length;browser.props.onDownload('C:\\Temp\\other.bin');browser.props.onUpload('D:\\Other');ui.find(node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[ui.file('replace.bin')]}});ui.render();await new Promise(resolve=>setImmediate(resolve));assert.equal(ui.calls.length,countBefore);assert.equal(ui.inputs.length,choicesBefore);assert.ok(ui.nodes().map(ui.text).join(' ').includes('C:\\Temp'));checks+=3;
ui.button('Fortsetzen').props.onClick();ui.render();await ui.settle();const uploadCreates=ui.calls.filter(call=>call.payload?.action==='create');assert.equal(uploadCreates.length,2,'resume reuses first ID and then uploads only remaining file');assert.deepEqual(uploadCreates.map(call=>call.payload.path),['C:\\Temp\\first.bin','C:\\Temp\\second.bin']);assert.equal(ui.confirmations,1,'resume retains original confirmed targets');assert.ok(ui.noticeLog.some(item=>item.name==='second.bin'&&item.phase==='streaming'),'batch progress uses current file name');checks++;assert.ok(ui.nodes().map(ui.text).join(' ').includes('Vom Agent geprüft und gespeichert'));checks+=4;ui.unmount();
// Explicit cancellation aborts the live request and cancels only the known ID.
ui=harness({chunkHandler:async(_url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Abgebrochen','AbortError')),{once:true}))});ui.choose();ui.button('Hochladen').props.onClick();ui.render();ui.confirmUpload();await ui.settle(()=>ui.calls.some(call=>call.kind==='chunk'));ui.button('Dateitransfer abbrechen').props.onClick();await ui.settle();assert.equal(ui.calls.filter(call=>call.payload?.action==='cancel').length,1);assert.equal(ui.calls.find(call=>call.payload?.action==='cancel').payload.id,'transfer-upload-1');assert.equal(ui.saved.length,0);assert.ok(ui.nodes().map(ui.text).join(' ').includes('abgebrochen'));checks+=4;ui.unmount();
// Management revocation changes the scope and aborts even an adapter that
// returns its create response after cancellation. Old work cannot download.
let releaseCreate;ui=harness({apiHandler:async(url,payload,signal,defaults)=>payload?.action==='create'?new Promise(resolve=>{releaseCreate=()=>resolve({id:'late-download'});}):defaults(url,payload,signal)});ui.find(node=>node.type==='FileBrowser').props.onDownload('C:\\Temp\\report.bin');ui.render();ui.props.server={...ui.props.server,management:0};ui.render();releaseCreate();await ui.settle();assert.equal(ui.saved.length,0);assert.equal(ui.calls.filter(call=>call.kind==='chunk').length,0);checks+=2;ui.unmount();
// Retrying a failed poll observes the same intentionally created transfer and
// saves once; it does not create another Agent request or scan history.
let failPoll=true;ui=harness({apiHandler:async(url,payload,signal,defaults)=>{if(!payload&&failPoll){failPoll=false;throw Error('Network interruption');}return defaults(url,payload,signal);}});ui.find(node=>node.type==='FileBrowser').props.onDownload('C:\\Temp\\report.bin');ui.render();await ui.settle();assert.equal(ui.saved.length,0);ui.button('Fortsetzen').props.onClick();ui.render();await ui.settle();assert.deepEqual(ui.saved,['report.bin']);assert.equal(ui.calls.filter(call=>call.payload?.action==='create').length,1);checks+=3;ui.unmount();
// The write-only destination must remain frozen while an upload is paused.
ui=harness({read:false,chunkHandler:async(_url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Abgebrochen','AbortError')),{once:true}))});ui.button('Dateien hochladen').props.onClick();ui.render();ui.find(node=>node.type==='input'&&node.props.className==='mono').props.onChange({target:{value:'C:\\Temp'}});ui.find(node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[ui.file()]}});ui.render();ui.button('Hochladen').props.onClick();ui.render();ui.confirmUpload();await ui.settle(()=>ui.calls.some(call=>call.kind==='chunk'));ui.button('Pausieren').props.onClick();await ui.settle(()=>!!ui.find(node=>node.type==='Btn'&&ui.text(node)==='Fortsetzen'));assert.equal(ui.find(node=>node.type==='input'&&node.props.className==='mono').props.disabled,true);assert.equal(ui.find(node=>node.type==='input'&&node.props.type==='file').props.disabled,true);checks+=2;ui.unmount();
let releaseAfterUnmount;ui=harness({apiHandler:async(url,payload,signal,defaults)=>payload?.action==='create'?new Promise(resolve=>{releaseAfterUnmount=()=>resolve({id:'unmounted-download'});}):defaults(url,payload,signal)});ui.find(node=>node.type==='FileBrowser').props.onDownload('C:\\Temp\\report.bin');ui.render();ui.unmount();releaseAfterUnmount();await new Promise(resolve=>setImmediate(resolve));assert.equal(ui.saved.length,0);assert.equal(ui.calls.filter(call=>call.kind==='chunk').length,0);checks+=2;
// the upload section on kit parts; Upload is blocked without a file; the ConfirmDialog names count, device and folder.
ui=harness();ui.find(node=>node.type==='FileBrowser').props.onUpload('C:\\Temp');ui.render();
assert.equal(ui.find(node=>node.type==='Card').props.className,'transfer-upload','the upload section is a kit Card');
assert.equal(ui.button('Hochladen').props.blocked,'Wähle zuerst eine Datei aus.','without a file Upload is blocked with the reason');assert.equal(ui.button('Hochladen').props.disabled,undefined,'no native disabled');
ui.button('Hochladen').props.onClick();ui.render();assert.equal(ui.find(node=>node.type==='ConfirmDialog').props.open,false,'a blocked Upload opens nothing');
ui.find(node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[ui.file('a.bin'),ui.file('b.bin'),ui.file('c.bin')]}});ui.render();
ui.button('Hochladen').props.onClick();ui.render();
let ask=ui.find(node=>node.type==='ConfirmDialog');
assert.deepEqual([ask.props.open,ask.props.title,ask.props.lines,ask.props.body,ask.props.confirmLabel],[true,'3 Dateien hochladen?',[{label:'Gerät',value:'HOST'},{label:'Ordner',value:'C:\\Temp',mono:true}],undefined,'Hochladen'],'the upload dialog: plural title, Device and Folder lines, the verb');
assert.equal(ui.calls.filter(call=>call.payload?.action==='create').length,0,'nothing is sent before the confirmation');
ask.props.onOpenChange(false);ui.render();assert.equal(ui.find(node=>node.type==='ConfirmDialog').props.open,false,'Cancel closes the dialog and sends nothing');
ui.find(node=>node.type==='Switch').props.onChange(true);ui.render();ui.button('Hochladen').props.onClick();ui.render();ask=ui.find(node=>node.type==='ConfirmDialog');
assert.equal(ask.props.body,'Dateien mit gleichem Namen in diesem Ordner werden überschrieben.','overwrite on: the overwrite sentence');
ui.find(node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[ui.file('one.bin')]}});ui.render();assert.equal(ui.find(node=>node.type==='ConfirmDialog').props.title,'1 Datei hochladen?','one file: the singular title');
ui.unmount();checks+=8;
// The overwrite option is one kit Switch, off by default; it applies at once and travels per file in the create request.
for(const overwrite of [false,true]){
 ui=harness({chunkHandler:async()=>new Response('{}',{headers:{'Content-Type':'application/json'}})});ui.choose([ui.file('a.bin'),ui.file('b.bin')]);
 const switches=ui.nodes().filter(node=>node.type==='Switch');assert.equal(switches.length,1,'exactly one Switch in the upload card');
 assert.deepEqual([switches[0].props.label,switches[0].props.checked,switches[0].props.blocked],['Vorhandene Dateien überschreiben',false,undefined],'the Switch: files.upload.overwrite, off by default, free while idle');
 assert.ok(!ui.nodes().some(node=>node.type==='input'&&node.props.type==='checkbox'),'no raw checkbox next to it');
 if(overwrite){switches[0].props.onChange(true);ui.render();assert.equal(ui.find(node=>node.type==='Switch').props.checked,true,'a toggle applies at once');}
 ui.button('Hochladen').props.onClick();ui.render();assert.equal(ui.find(node=>node.type==='ConfirmDialog').props.body,overwrite?'Dateien mit gleichem Namen in diesem Ordner werden überschrieben.':undefined,'the confirmation names overwrite only when it is on');
 ui.confirmUpload();const creates=()=>ui.calls.filter(call=>call.payload?.action==='create');await ui.settle(()=>creates().length===2&&!ui.find(node=>node.type==='FileBrowser')?.props.transferBusy);
 assert.deepEqual(creates().map(call=>[call.payload.path,call.payload.overwrite]),[['C:\\Temp\\a.bin',overwrite],['C:\\Temp\\b.bin',overwrite]],'each create request carries overwrite: '+overwrite);
 ui.unmount();checks+=5;
}
console.log(`PASS file transfer actions (${checks} assertions): real single-click autosave and exact-ID polling, idle silence, temporary success, upload pause/resume batch integrity and exclusivity, explicit cancel, scope revocation, and the upload card with its overwrite Switch and ConfirmDialog.`);
