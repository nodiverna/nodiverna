// Exercise the actual download of step 2 of Add device (AgentDownload in
// ui/devices/add-device/add-device.tsx): the protected agent download is the
// browser-native link in every context, plus the agent guides.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import React from 'react';
import {i18nRequire,translateModule} from '../../support/i18n-stubs.mjs';
const {translate}=translateModule;
const root=process.cwd(),require=createRequire(import.meta.url),cache=new Map(),origin='https://serverdesk.test';
const timers=new Map(),blobs=new Map();let active,hookIndex=0,now=0,timerId=0,network=[],replies=[],saved=[],revoked=[];
const sameDeps=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
const react={...React,
 useState(initial){const index=hookIndex++,owner=active;if(!owner.hooks[index])owner.hooks[index]={value:typeof initial==='function'?initial():initial};const slot=owner.hooks[index];return [slot.value,next=>{slot.value=typeof next==='function'?next(slot.value):next;owner.dirty=true;}];},
 useRef(initial){const index=hookIndex++;if(!active.hooks[index])active.hooks[index]={current:initial};return active.hooks[index];},
 useEffect(fn,deps){const index=hookIndex++,previous=active.hooks[index];if(previous&&sameDeps(previous.deps,deps))return;active.hooks[index]={deps,cleanup:previous?.cleanup};active.pending.push({index,fn});},
 useSyncExternalStore(subscribe,getSnapshot,getServerSnapshot){const index=hookIndex++,owner=active,previous=owner.hooks[index];if(!previous||previous.subscribe!==subscribe){owner.hooks[index]={subscribe,cleanup:previous?.cleanup};owner.pending.push({index,fn:()=>typeof window==='undefined'?undefined:subscribe(()=>{owner.dirty=true;})});}return typeof window==='undefined'?getServerSnapshot():getSnapshot();},
};
function load(filename){
 const absolute=path.resolve(filename);if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 // The tab Several devices is not part of this test; it stays a boundary.
 if(absolute===path.resolve('ui/devices/add-device/add-device-installers.tsx'))return {__esModule:true,default:'AddDeviceInstallers'};
 const source=fs.readFileSync(absolute,'utf8'),mod={exports:{}};cache.set(absolute,mod);
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const localRequire=id=>{const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;if(id==='react')return react;if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id);const file=[base,base+'.ts',base+'.tsx',base+'.js'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());if(file)return load(file);}return require(id);};
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
class Harness{
 constructor(component,props){this.component=component;this.props=props;this.hooks=[];this.pending=[];this.dirty=true;this.render();}
 render(){active=this;hookIndex=0;this.dirty=false;this.pending=[];this.tree=this.component(this.props);for(const effect of this.pending){const slot=this.hooks[effect.index];slot.cleanup?.();slot.cleanup=effect.fn();}active=null;}
 async settle(){for(let i=0;i<80;i++){await Promise.resolve();if(this.dirty)this.render();}}
 dispose(){for(const hook of this.hooks)hook?.cleanup?.();}
}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const child of node){const found=find(child,predicate);if(found)return found;}return null;}if(predicate(node))return node;return find(node.props?.children,predicate);}
function text(node){if(node==null||typeof node==='boolean')return '';if(typeof node!=='object')return String(node);if(Array.isArray(node))return node.map(text).join('');if(typeof node.type==='function'&&node.props?.parts)return text(node.type(node.props));return text(node.props?.children);}
function link(harness){const node=find(harness.tree,node=>node.props?.href==='/api/agent/download');assert.ok(node,'download link exists');return node;}
function click(harness){let prevented=false;link(harness).props.onClick?.({preventDefault(){prevented=true;}});return prevented;}
const original={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,createObjectURL:URL.createObjectURL,revokeObjectURL:URL.revokeObjectURL};
globalThis.setTimeout=(callback,ms=0)=>{const id=++timerId;timers.set(id,{callback,due:now+ms});return id;};globalThis.clearTimeout=id=>timers.delete(id);
const windowTarget=new EventTarget();windowTarget.location={origin,href:origin+'/'};windowTarget.top=windowTarget;windowTarget.self=windowTarget;globalThis.window=windowTarget;
globalThis.document={body:{appendChild(){}},createElement(){return {href:'',download:'',click(){saved.push({href:this.href,name:this.download,blob:blobs.get(this.href)});},remove(){}};}};
URL.createObjectURL=blob=>{const url='blob:'+origin+'/'+(blobs.size+1);blobs.set(url,blob);return url;};URL.revokeObjectURL=url=>{revoked.push(url);blobs.delete(url);};
globalThis.fetch=async(input,init={})=>{
 const url=new URL(input instanceof Request?input.url:String(input),origin),record={url,method:init.method??'GET',headers:new Headers(init.headers),signal:init.signal,credentials:init.credentials};network.push(record);const next=replies.shift();assert.notEqual(next,undefined,'unexpected fetch '+url.pathname);
 if(next.promise)return new Promise((resolve,reject)=>{const abort=()=>reject(init.signal.reason??new DOMException('Aborted','AbortError'));if(init.signal?.aborted){abort();return;}init.signal?.addEventListener('abort',abort,{once:true});next.promise.then(value=>{init.signal?.removeEventListener('abort',abort);resolve(value);},error=>{init.signal?.removeEventListener('abort',abort);reject(error);});});
 return next;
};
const {AgentDownload}=load('ui/devices/add-device/add-device.tsx'),guide=load('ui/devices/add-device/agent-guide.ts'),kit=load('ui/kit/kit.tsx');
const harnesses=[];
function mount(){const harness=new Harness(AgentDownload,{});harnesses.push(harness);return harness;}
function reset(){for(const harness of harnesses.splice(0))harness.dispose();network=[];replies=[];saved=[];revoked=[];blobs.clear();timers.clear();now=0;window.top=window;}
try{
 // The download link serves the latest release: the component reads the catalog
 // once. While it loads, a skeleton stands where the link goes.
 const catalog=releases=>new Response(JSON.stringify({releases}),{status:200,headers:{'Content-Type':'application/json'}});
 const latest=[{version:'4.13.0',latest:true},{version:'4.12.0',latest:false}];
 const loaded=async reply=>{replies.push(reply);const harness=mount();await harness.settle();return harness;};
 reset();let pending;replies.push({promise:new Promise(resolve=>{pending=resolve;})});let component=mount();
 const skeleton=find(component.tree,node=>node.type===kit.Skeleton);
 assert.ok(skeleton,'a kit Skeleton while the release loads');assert.equal(skeleton.props.label,'Agent-Release wird geladen');
 assert.equal(find(component.tree,node=>node.props?.href==='/api/agent/download'),null,'no link before the release is known');
 assert.deepEqual([network.length,network[0].url.pathname,network[0].method],[1,'/api/releases','GET'],'one catalog read');
 pending(catalog(latest));await component.settle();
 // The protected download is always the native link. The HttpOnly
 // session cookies authenticate it; no script fetches, buffers or saves a blob.
 assert.equal(link(component).props.download,'ServerDesk.Agent.exe');assert.equal(link(component).props.onClick,undefined,'no click handler intercepts the native link');assert.equal(click(component),false,'direct view keeps native streamed link navigation');assert.equal(network.length,1,'the download adds no JS fetch or buffering');
 const version=find(component.tree,node=>typeof node.props?.className==='string'&&node.props.className.includes('mono'));assert.equal(text(version),'Agent 4.13.0','the version of the latest release next to the link');
 assert.equal(find(component.tree,node=>node.props?.role==='status'||node.props?.role==='alert'),null,'no progress or error UI of a scripted download');
 for(const top of [{location:{origin}},{}]){reset();window.top=top;component=await loaded(catalog(latest));assert.equal(click(component),false,'a frame also keeps the native download');assert.equal(network.length,1);assert.equal(saved.length,0,'no blob download');assert.equal(blobs.size,0);}
 // Without a latest release a notice with one link to the Releases page replaces the link.
 for(const releases of [[],[{version:'4.12.0',latest:false}]]){
  reset();component=await loaded(catalog(releases));
  assert.equal(find(component.tree,node=>node.props?.href==='/api/agent/download'),null,'no download without a release');
  const notice=find(component.tree,node=>node.type===kit.Notice);assert.equal(notice?.props.tone,'info','an info notice');
  assert.match(text(notice.props.children),/^Noch ist kein Agent-Release verfügbar\. Ein Owner importiert Agent-Releases unter Einstellungen → Agent-Releases\./);
  assert.deepEqual([notice.props.action.props.href,text(notice.props.action)],['#settings/agent-releases','Agent-Releases öffnen'],'the notice links to the agent releases');
 }
 // A failed load shows the link without a version; the route gives its own error.
 reset();component=await loaded(new Response(JSON.stringify({error:'down'}),{status:500,headers:{'Content-Type':'application/json'}}));
 assert.ok(link(component));assert.equal(find(component.tree,node=>typeof node.props?.className==='string'&&node.props.className.includes('mono')),null,'no version after a failed load');

 // Step 2 names the requirements; the install and repair commands of steps 3 and the disclosure (tests/ui/devices/add-device-page.mjs).
 const requirements=translate('de','agents.install.requirements');
 assert.match(requirements,/Windows Server 2022, Windows Server 2025/);assert.match(requirements,/Windows 11 Pro oder Enterprise/);
 // The harness renders German: the placeholder comes from the catalog and the command stays byte-equal to the old literal.
 assert.equal(guide.agentInstallCommand('ServerDesk-GERAET.registration.json'),'.\\ServerDesk.Agent.exe --install --config .\\ServerDesk-GERAET.registration.json');
 const page=fs.readFileSync('ui/devices/add-device/add-device.tsx','utf8');
 assert.ok(page.includes('agentInstallCommand(fileName)')&&page.includes('command={agentRepairCommand}'),'the page shows the install and repair commands');
 assert.doesNotMatch(page,/Bootstrap-ServerDesk|Install-ServerDesk/);
 // The uninstall guide and the diagnosis commands live in Agent troubleshooting (ui/settings/troubleshooting.tsx);
 // tests/ui/kit/kit-parts.mjs renders it. The classic AgentTroubleshooting and its file are deleted.
 assert.ok(!fs.existsSync('app/agent-installation.tsx'),'app/agent-installation.tsx does not exist');
 const troubleshootingSource=fs.readFileSync('ui/settings/troubleshooting.tsx','utf8');
 assert.match(troubleshootingSource,/<CommandBlock command=\{agentUninstallCommand\}\/>/,'the uninstall command is a CommandBlock of Agent troubleshooting');
 for(const name of ['agentStatusCommand','agentHealthCommand','agentLogsCommand','agentCacheCommand','agentConnectivityCommand(portalOrigin)'])assert.ok(troubleshootingSource.includes('command:'+name)||troubleshootingSource.includes('command={'+name),'troubleshooting renders '+name);
 assert.match(troubleshootingSource,/const portalOrigin=useSyncExternalStore\(subscribePortalOrigin,portalOriginSnapshot,portalOriginServerSnapshot\);/,'the page reads the portal origin from the shared store');
 // The portal origin store as the page reads it: the current origin, an update on navigation, and a fixed origin on the server.
 reset();
 const Probe=()=>({type:'pre',props:{children:guide.agentConnectivityCommand(react.useSyncExternalStore(guide.subscribePortalOrigin,guide.portalOriginSnapshot,guide.portalOriginServerSnapshot))}});
 const probe=new Harness(Probe,{});harnesses.push(probe);await probe.settle();
 assert.ok(text(probe.tree).includes("$portal = '"+origin+"'")&&text(probe.tree).includes('$portal/api/health/live'),'HTTPS check uses the current portal origin');
 window.location.origin='https://192.168.1.10:8443';window.dispatchEvent(new Event('popstate'));await probe.settle();assert.ok(text(probe.tree).includes("$portal = 'https://192.168.1.10:8443'"),'external location snapshot updates the displayed connectivity command');window.location.origin=origin;
 delete globalThis.window;try{const serverGuide=new Harness(Probe,{});assert.ok(text(serverGuide.tree).includes("$portal = 'https://dein-portal'"),'server rendering uses a deterministic origin without accessing window');serverGuide.dispose();}finally{globalThis.window=windowTarget;}
 assert.equal(network.length,0,'opening a guide never stops, mutates or contacts a managed device');
 assert.equal(guide.agentConnectivityCommand('https://192.168.1.10:8443/path?q=x'),"$portal = 'https://192.168.1.10:8443'\nInvoke-WebRequest -Uri \"$portal/api/health/live\" -UseBasicParsing");
 for(const unsafe of ['http://example.test','https://user:secret@example.test','not a URL'])assert.ok(!guide.agentConnectivityCommand(unsafe).includes(unsafe),'unsafe or credentialed origins do not enter the command');
 const store=fs.readFileSync('agent/v3/LocalStore.cs','utf8'),service=fs.readFileSync('agent/v3/NativeServiceSetup.cs','utf8'),installer=fs.readFileSync('agent/v3/AgentInstaller.cs','utf8'),worker=fs.readFileSync('agent/v3/AgentWorker.cs','utf8');
 assert.match(store,/Path\.Combine\(root, "agent-v3\.log"\)/);const protocol=fs.readFileSync('agent/v3/BrokerProtocol.cs','utf8');assert.match(protocol,/BrokerService = "ServerDeskAgent", WorkerService = "ServerDeskWorker"/);assert.match(protocol,/WorkerHealthPath\(string root\) => Path\.Combine\(WorkerRoot\(root\), "v3-health\.json"\)/);assert.match(store,/Path\.Combine\(logDirectory, "agent-worker\.log"\)/);assert.match(service,/DOTNET_BUNDLE_EXTRACT_BASE_DIR=" \+ extraction/);
 assert.match(installer,/Run installation from the downloaded EXE outside/);assert.match(installer,/run the downloaded EXE --uninstall from outside/);assert.match(worker,/BrokerProtocol\.WorkerHealthPath\(root\)/);
 // Execute the displayed PowerShell cleanup against instrumented cmdlets. It
 // must preserve credentials/releases and refuse live processes, update plans
 // and junctions before issuing any removal. No real files/services are touched.
 if(process.platform==='win32'){
  for(const scenario of ['clean','no-cache','pending-update','maintenance','running','process','root-link','cache-link','child-link','wrong-path']){
   const script=String.raw`$scenario = '${scenario}'
$env:ProgramData = 'C:\ProgramData'
$removed = @()
$started = $false
$failure = $null
function Test-Path { param($LiteralPath) if ($LiteralPath -like '*update-plan.bin') { return $scenario -eq 'pending-update' }; if ($LiteralPath -like '*install-maintenance.bin') { return $scenario -eq 'maintenance' }; return $scenario -ne 'no-cache' }
function Stop-Service { param($Name,[switch]$Force,$ErrorAction) }
function Start-Service { param($Name,$ErrorAction) $script:started = $true }
function Get-Service { param($Name) [pscustomobject]@{Status=$(if($scenario -eq 'running'){'Running'}else{'Stopped'})} }
function Get-Process { param($Name,$ErrorAction) if ($scenario -eq 'process') { [pscustomobject]@{Id=123} } }
function Get-Item { param($LiteralPath,[switch]$Force,$ErrorAction) $isCache=$LiteralPath -like '*runtime'; $isLink=($isCache -and $scenario -eq 'cache-link') -or (!$isCache -and $scenario -eq 'root-link'); [pscustomobject]@{FullName=$(if($isCache -and $scenario -eq 'wrong-path'){'C:\outside'}else{$LiteralPath});Attributes=$(if($isLink){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Directory})} }
function Get-ChildItem { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction) [pscustomobject]@{FullName='C:\ProgramData\ServerDesk\runtime\bundle';Attributes=$(if($Recurse -and $scenario -eq 'child-link'){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Directory})} }
function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction) $script:removed += $LiteralPath }
try {
${guide.agentCacheCommand}
} catch { $failure = $_.Exception.Message }
[pscustomobject]@{Removed=@($removed);Started=$started;Failure=$failure} | ConvertTo-Json -Compress`;
   const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000});
   assert.equal(result.status,0,'PowerShell cleanup syntax and mocked execution: '+scenario+' '+result.stderr);
   const outcome=JSON.parse(result.stdout.trim());
   if(scenario==='clean'){assert.deepEqual(outcome.Removed,['C:\\ProgramData\\ServerDesk\\runtime\\bundle','C:\\ProgramData\\ServerDesk\\runtime\\bundle'],'broker and worker runtime caches');assert.equal(outcome.Started,true);assert.equal(outcome.Failure,null);}
   else if(scenario==='no-cache'){assert.deepEqual(outcome.Removed,[]);assert.equal(outcome.Started,true);assert.equal(outcome.Failure,null);}
   else{assert.deepEqual(outcome.Removed,[],'guarded scenario never deletes files: '+scenario);assert.equal(outcome.Started,false);assert.ok(outcome.Failure);}
  }
 }
 console.log('PASS agent installation download: the version of the latest release or a notice with a link to the agent releases, a kit skeleton while it loads; always the native streamed link, no scripted fetch, no blob, also inside a frame.');
 console.log('PASS native agent guides: current install/uninstall paths, service/log/heartbeat instructions, portal-origin HTTPS check and guarded runtime-cache cleanup preserve credentials and rollback state.');
}finally{
 for(const harness of harnesses)harness.dispose();Object.assign(globalThis,{window:original.window,document:original.document,fetch:original.fetch,setTimeout:original.setTimeout,clearTimeout:original.clearTimeout});URL.createObjectURL=original.createObjectURL;URL.revokeObjectURL=original.revokeObjectURL;
}
