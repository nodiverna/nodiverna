// Automation → Desired state in the console: drafts and validation, the immutable source, assignment conflicts,
// version status, job states, result detail and feedback.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map();
function load(filename){
 const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 const mod={exports:{}};cache.set(absolute,mod);const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}return require(id);}
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const ui=load('ui/automation/desired-state-ui.ts'),operations=load('lib/desired-state-operations.ts'),views=load('ui/automation/desired-state-components.tsx');
let checks=0;const check=fn=>{fn();checks++;},render=(name,props)=>renderToStaticMarkup(React.createElement(views[name],props));
const at=Date.now(),version={id:'version',configId:'config',version:3,engine:'powershell-dsc',sha256:'a'.repeat(64),configurationName:'CustomBaseline',parameters:{Path:'C:\\Managed'},source:{kind:'portal'},createdAt:at,content:'Configuration CustomBaseline { Node localhost {} }'},assignment={id:'assignment',serverId:'server',versionId:'version',enabled:true,intervalSeconds:0,lastCheckedAt:null};
const result={engine:'powershell-dsc',runtime:'Windows PowerShell DSC',compliant:true,rebootPending:false,checkedAt:new Date(at).toISOString(),resources:[{name:'Managed folder',type:'File',inDesiredState:true,differingProperties:[]}]};
const successful={id:'success',assignmentId:'assignment',serverId:'server',versionId:'version',jobId:'job',operation:'test',state:'succeeded',message:'Configuration matches.',createdAt:at-1000,resultAt:at-500,data:result};
check(()=>{const drafts=ui.desiredDrafts();assert.match(drafts['powershell-dsc'].content,/Configuration ServerDeskConfig/);assert.doesNotMatch(drafts['powershell-dsc'].content,/"resources"/);assert.equal(drafts.mof.content,'');const json=drafts.dsc3.content;drafts['powershell-dsc'].content='Configuration MyEditedBaseline {}';assert.equal(drafts.dsc3.content,json,'switching back retains the independent JSON draft');});
check(()=>{const drafts=ui.desiredDrafts(version);assert.equal(drafts['powershell-dsc'].configurationName,'CustomBaseline');assert.equal(JSON.parse(drafts['powershell-dsc'].parameters).Path,'C:\\Managed');assert.notEqual(drafts.dsc3.content,version.content);assert.equal(drafts.mof.content,'');});
check(()=>{assert.equal(ui.desiredFileEngine('Baseline.PS1'),'powershell-dsc');assert.equal(ui.desiredFileEngine('windows/localhost.mof'),'mof');assert.equal(ui.desiredFileEngine('windows/baseline.dsc.json'),'dsc3');assert.equal(ui.desiredFileEngine('unsafe.exe'),null);});
check(()=>{operations.validateDesiredContent('powershell-dsc',version.content,'CustomBaseline');operations.validateDesiredContent('mof','// Generated MOF\ninstance of MSFT_FileDirectoryConfiguration as $x { Ensure = "Present"; };');assert.throws(()=>operations.validateDesiredContent('powershell-dsc',operations.desiredTemplates.dsc3,'CustomBaseline'),/Quelltext ist JSON/);assert.throws(()=>operations.validateDesiredContent('mof',operations.desiredTemplates.dsc3),/Quelltext ist JSON/);assert.throws(()=>operations.validateDesiredContent('dsc3',version.content),/gültiges JSON/);});
check(()=>{const queued={...successful,id:'queued',state:'pending',data:result,createdAt:at};assert.deepEqual(ui.desiredRunStatus(queued),{label:'Wartend',tone:'live'});assert.equal(ui.desiredRunStatus({...successful,state:'failed'}).tone,'danger','failed job cannot turn green even when an output contains compliant:true');assert.equal(ui.desiredRunStatus({...successful,data:{...result,compliant:false}}).label,'Abweichend');});
check(()=>{const foreign={...successful,id:'foreign',versionId:'other-version',createdAt:at};const state=ui.desiredAssignmentRuns({...assignment,latestRun:foreign,latestComplianceRun:foreign},[successful,foreign]);assert.equal(state.latest.id,successful.id);assert.equal(state.compliance.id,successful.id);assert.equal(ui.desiredAssignmentRuns(assignment,[{...successful,assignmentId:'other'}]).latest,null);});
const device={management:1,snapshot:{mode:'Management',protocolVersion:3,os:'Microsoft Windows Server 2025 Datacenter',agentCapabilities:['desired-state-test']}};
check(()=>{assert.equal(ui.desiredExecutionReason(device,true,'test'),'');assert.match(ui.desiredExecutionReason(device,true,'apply'),/anzuwenden/);assert.match(ui.desiredExecutionReason({...device,snapshot:{...device.snapshot,mode:'ReadOnly'}},true,'test'),/direkt auf dem Gerät ein/);assert.match(ui.desiredExecutionReason(device,false,'test'),/Berechtigung/);assert.match(ui.desiredExecutionReason({...device,snapshot:{...device.snapshot,os:'Windows Server 2016'}},true,'test'),/Windows Server 2025/);});
check(()=>{const target={versionId:'version',intervalSeconds:0,canManage:true,executionReason:'Management fehlt.'};assert.equal(ui.desiredTargetReason(target),'','manual reference assignment remains possible before runtime setup');assert.match(ui.desiredTargetReason({...target,assignment:{...assignment,versionId:'older'}}),/Entferne zuerst die bestehende Zuweisung/);assert.match(ui.desiredTargetReason({...target,assignment,intervalSeconds:900}),/Prüfplan/);assert.match(ui.desiredTargetReason({...target,intervalSeconds:900}),/Management/);assert.match(ui.desiredTargetReason({...target,canManage:false}),/Berechtigung/);});
check(()=>{const html=render('DesiredVersionSource',{version,name:'Baseline',source:version,loading:false,error:''});assert.match(html,/Baseline-v3\.ps1/);assert.match(html,/Gespeicherte PowerShell-Konfiguration/);assert.match(html,/Configuration CustomBaseline/);assert.doesNotMatch(html,/JSON-Konfiguration/);});
check(()=>{const wrong={...version,id:'old-version',content:'NEVER SHOW OLD SOURCE'};const html=render('DesiredVersionSource',{version,name:'Baseline',source:wrong,loading:false,error:''});assert.doesNotMatch(html,/NEVER SHOW OLD SOURCE/);assert.match(html,/noch nicht verfügbar/);});
check(()=>{const json={...version,engine:'dsc3',content:operations.desiredTemplates.dsc3};const html=render('DesiredVersionSource',{version:json,name:'Baseline',source:json,loading:false,error:''});assert.match(html,/Baseline-v3\.json/);assert.doesNotMatch(html,/Configuration-Name/,'legacy invalid ConfigurationName must not mislabel JSON');const mof={...version,engine:'mof',content:'instance of Test {}'};assert.doesNotMatch(render('DesiredVersionSource',{version:mof,name:'Baseline',source:mof,loading:false,error:''}),/>Parameter</,'MOF cannot show hidden legacy parameters');});
check(()=>{const queued={...successful,id:'queued',state:'pending',createdAt:at,data:null};const html=render('DesiredDeviceState',{assignment:{...assignment,latestRun:queued,latestComplianceRun:successful},configs:[{id:'config',name:'Baseline',description:'',versions:[version]}],runs:[],deviceName:'VM-01',connected:false});assert.match(html,/Wartet darauf, dass sich der Agent verbindet/);assert.match(html,/Letztes Prüfergebnis/);assert.match(html,/>Erfüllt</,'previous actual result remains visible separately from queued action');});
check(()=>{const failed={...successful,id:'failed',state:'failed',message:'Resource not installed',createdAt:at,data:null};const html=render('DesiredDeviceState',{assignment:{...assignment,latestRun:failed,latestComplianceRun:successful},configs:[{id:'config',name:'Baseline',description:'',versions:[version]}],runs:[],deviceName:'VM-01',connected:true});assert.match(html,/Fehlgeschlagen/);assert.match(html,/Resource not installed/);assert.match(html,/letzten erfolgreichen Ausführung/);});
check(()=>{const html=render('DesiredRunDetails',{run:{...successful,state:'failed',message:'Cannot execute'},deviceName:'VM-01',versionLabel:'Baseline · v3'});assert.doesNotMatch(html,/Managed folder/,'failed run does not display a successful resource verdict');assert.match(html,/Cannot execute/);});
check(()=>{const html=render('DesiredResources',{result:{...result,compliant:false,resources:[{name:'Folder',type:'File',inDesiredState:false,differingProperties:['Ensure']},{name:'Unknown',type:'Registry',inDesiredState:null,differingProperties:[]}]}});assert.match(html,/2 Ressourcen/);assert.match(html,/1 abweichend/);assert.match(html,/Ensure/);assert.match(html,/Unbekannt/);});
check(()=>{const html=render('DesiredFeedback',{text:'Version zugewiesen. Noch nicht ausgeführt.',onDismiss:()=>{}});assert.match(html,/role="status"/);assert.match(html,/aria-live="polite"/);assert.match(html,/Noch nicht ausgeführt/);});


check(()=>{const html=render('DesiredVersionSource',{version,name:'Baseline',source:version,loading:true,error:''});assert.match(html,/Configuration CustomBaseline/,'source remains visible while the same version refreshes');assert.doesNotMatch(html,/sdx-skeleton-set/);});
check(()=>{const html=render('DesiredRunDetails',{run:{...successful,data:null},deviceName:'Server',versionLabel:'v3',loading:true});assert.match(html,/class="sdx-skeleton-set sdx-skeleton-facts" role="status" aria-label="Ausführungsergebnis wird geladen"/);assert.doesNotMatch(html,/keine strukturierten Compliance-Daten/,'missing-data message waits for detail response');});
// After job retention the assignment's stored result and verdict are the fallback; runs still win while they exist.
check(()=>{const state=ui.desiredAssignmentRuns({...assignment,lastResultState:'succeeded',lastResultAt:at,lastCompliant:false,lastCompliantAt:at-10},[]);assert.equal(state.latest,null);assert.equal(state.compliance,null);assert.equal(state.compliant,false);assert.equal(state.compliantAt,at-10);assert.deepEqual(state.status,{label:'Abweichend',tone:'warning'});});
check(()=>{const state=ui.desiredAssignmentRuns({...assignment,lastResultState:'failed',lastResultAt:at,lastCompliant:true,lastCompliantAt:at-10},[]);assert.deepEqual(state.status,{label:'Fehlgeschlagen',tone:'danger'});assert.equal(state.compliant,true,'a stored failure keeps the previous verdict');});
check(()=>{assert.deepEqual(ui.desiredAssignmentRuns({...assignment,lastResultState:'succeeded',lastResultAt:at,lastCompliant:null,lastCompliantAt:null},[]).status,{label:'Abgeschlossen',tone:'neutral'});assert.deepEqual(ui.desiredAssignmentRuns({...assignment,lastResultState:'succeeded',lastResultAt:at,lastCompliant:true,lastCompliantAt:at},[]).status,{label:'Erfüllt',tone:'good'});});
check(()=>{const state=ui.desiredAssignmentRuns(assignment,[]);assert.deepEqual([state.compliant,state.compliantAt,state.status],[null,null,{label:'Noch nicht geprüft',tone:'neutral'}],'no runs and no stored state');});
check(()=>{const state=ui.desiredAssignmentRuns({...assignment,lastResultState:'succeeded',lastCompliant:false,lastCompliantAt:at+5000},[successful]);assert.equal(state.compliance.id,successful.id);assert.equal(state.compliant,true,'a compliance run wins over a contradicting stored verdict');assert.equal(state.compliantAt,result.checkedAt);assert.deepEqual(state.status,{label:'Erfüllt',tone:'good'});const queued={...successful,id:'queued',state:'pending',createdAt:at,data:null};assert.deepEqual(ui.desiredAssignmentRuns({...assignment,lastResultState:'failed',lastCompliant:false,lastCompliantAt:at},[queued]).status,{label:'Wartend',tone:'live'},'a present run decides the badge');});
check(()=>{const html=render('DesiredDeviceState',{assignment:{...assignment,lastJobId:'job',lastResultState:'succeeded',lastResultAt:at,lastCompliant:true,lastCompliantAt:at},configs:[{id:'config',name:'Baseline',description:'',versions:[version]}],runs:[],deviceName:'VM-01',connected:true});assert.match(html,/>Erfüllt</);assert.match(html,/<dt>Letztes Prüfergebnis<\/dt><dd>Erfüllt<small>/);assert.doesNotMatch(html,/Noch kein erfolgreiches Ergebnis/);assert.doesNotMatch(html,/Noch nicht geprüft/);assert.doesNotMatch(html,/role="alert"/,'no failed banner without a run');});
// ---- The panel on the kit (tests/support/panel-harness.mjs): Unavailable, the head, the Tabs and the confirmations ----
{
 const {panelHarness}=await import('../../support/panel-harness.mjs');
 const {de}=await import('../../support/i18n-stubs.mjs');
 class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
 const calls=[];let respond=()=>Promise.resolve({});
 const shared={api:(url,body)=>{calls.push({url,body});return respond(url,body);},ApiError,downloadText:()=>{},message:error=>error.message,online:()=>true,permitted:(device,viewer,right)=>viewer.permissions?.includes('*')===true||device.permissions?.includes(right)===true,stamp:value=>value?'T'+value:'–'};
 const harness=panelHarness({hooked:['ui/automation/desired-state-panel.tsx'],stubs:{'@/ui/base/api':shared}});
 const Panel=harness.load('ui/automation/desired-state-panel.tsx').default,{ConfirmDialog}=harness.load('ui/kit/confirm-dialog.tsx'),{Tabs}=harness.load('ui/kit/tabs.tsx');
 const owner={id:'owner',label:'Owner',permissions:['*']};
 const machine={id:'server',name:'VM-01',revoked:0,management:1,permissions:[],snapshot:{mode:'Management',protocolVersion:3,os:'Microsoft Windows Server 2025 Datacenter',agentCapabilities:['desired-state-test','desired-state-apply']}};
 const config={id:'config',name:'Baseline',description:'',versions:[version],versionCount:1,assignmentCount:1,canDelete:true};
 const data={configs:[config],assignments:[{...assignment,latestRun:successful,latestComplianceRun:successful}],runs:[successful],github:{privateAvailable:false}};
 const props={servers:[machine],viewer:owner,demo:false,serverId:'server'};
 const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ');
 const open=tree=>harness.walk(tree).find(node=>node.type===ConfirmDialog&&node.props.open);
 const field=(tree,label)=>harness.walk(tree).find(node=>node.props?.label===label&&node.props?.children?.props?.role==='switch')?.props.children;
 const mount=async(overrides={},value=data)=>{harness.reset();calls.length=0;respond=(url,body)=>Promise.resolve(body?{}:structuredClone(value));harness.tree(Panel,{...props,...overrides});await harness.flush();harness.tree(Panel,{...props,...overrides});await harness.flush();return harness.tree(Panel,{...props,...overrides});};
 // A sample device: the Desired State sentence, no tabs, no request.
 let tree=await mount({demo:true});let html=harness.html(Panel,{...props,demo:true});
 check(()=>{assert.match(html,/<h2 class="sr-only">Sollkonfiguration<\/h2>/);assert.ok(text(html).includes('Die Sollkonfiguration ist bei Beispielgeräten nicht verfügbar.'));assert.doesNotMatch(html,/role="tablist"|Sollkonfiguration ist verfügbar/);assert.equal(calls.length,0,'no request');});
 // With data: the Tabs with counts, the assignment card with Check and Apply.
 tree=await mount();html=harness.html(Panel,props);
 check(()=>{assert.equal(calls[0].url,'/api/desired-state?serverId=server');assert.deepEqual(harness.walk(tree).find(node=>node.type===Tabs).props.items.map(item=>[item.label,item.count]),[['Gerät',1],['Konfigurationen',1],['Verlauf',1]]);assert.equal((html.match(/role="tab"/g)||[]).length,3);assert.ok(text(html).includes(de('desired.subtitleDevice')));});
 // Apply: two switches, blocked until both are on, the classic body.
 harness.button(tree,'Anwenden').props.onClick();tree=harness.tree(Panel,props);let dialog=open(tree);
 check(()=>{assert.deepEqual([dialog.props.title,dialog.props.confirmLabel,dialog.props.tone,dialog.props.blocked,dialog.props.lines],[de('desired.applyTitle'),'Anwenden','default',de('desired.blocked.consent'),[{label:'Gerät',value:'VM-01'},{label:'Konfiguration',value:'Baseline · v3'}]]);assert.equal(dialog.props.body,de('desired.systemNote'));});
 field(tree,de('desired.approveRun')).props.onChange({target:{checked:true}});tree=harness.tree(Panel,props);
 check(()=>{assert.equal(open(tree).props.blocked,de('desired.blocked.consent'),'one approval is not enough for Apply');});
 field(tree,de('desired.approveChanges')).props.onChange({target:{checked:true}});tree=harness.tree(Panel,props);dialog=open(tree);
 check(()=>{assert.equal(dialog.props.blocked,undefined);assert.equal(field(tree,de('desired.approveChanges')).props.role,'switch');});
 dialog.props.onConfirm();await harness.settle();
 check(()=>{assert.deepEqual(calls.find(call=>call.body).body,{action:'apply',assignmentId:'assignment',confirmSystem:true,confirmMaintenance:true});});
 // Check: one switch and the verb "Prüfen".
 tree=await mount();harness.button(tree,'Prüfen').props.onClick();tree=harness.tree(Panel,props);dialog=open(tree);
 check(()=>{assert.deepEqual([dialog.props.title,dialog.props.confirmLabel],[de('desired.checkTitle'),'Prüfen']);assert.equal(field(tree,de('desired.approveChanges')),undefined);});
 field(tree,de('desired.approveRun')).props.onChange({target:{checked:true}});tree=harness.tree(Panel,props);open(tree).props.onConfirm();await harness.settle();
 check(()=>{assert.deepEqual(calls.find(call=>call.body).body,{action:'test',assignmentId:'assignment',confirmSystem:true,confirmMaintenance:false});});
 // Remove assignment: danger, no switches, the classic body.
 tree=await mount();harness.button(tree,'Zuweisung entfernen').props.onClick();tree=harness.tree(Panel,props);dialog=open(tree);
 check(()=>{assert.deepEqual([dialog.props.title,dialog.props.confirmLabel,dialog.props.tone,dialog.props.blocked,dialog.props.body],[de('automation.removeTitle'),'Zuweisung entfernen','danger',undefined,de('desired.removeDescription')]);assert.equal(field(tree,de('desired.approveRun')),undefined);});
 dialog.props.onConfirm();await harness.settle();
 check(()=>{assert.deepEqual(calls.find(call=>call.body).body,{action:'unassign',assignmentId:'assignment'});});
 // Delete configuration: danger, blocked with the server reason, the classic body.
 const reason={key:'serverMessage.desired.configDeleted',text:'In use.'};
 for(const [value,expected] of [[data,undefined],[{...data,configs:[{...config,canDelete:false,deleteReason:reason}]},de('serverMessage.desired.configDeleted')]]){
  tree=await mount({},value);harness.walk(tree).find(node=>node.type===Tabs).props.onChange('configs');tree=harness.tree(Panel,props);
  const remove=harness.button(tree,'Konfiguration löschen');
  check(()=>{assert.equal(remove.props.variant,'danger');assert.equal(remove.props.blocked,expected);});
  if(expected)continue;
  remove.props.onClick();tree=harness.tree(Panel,props);dialog=open(tree);
  check(()=>{assert.deepEqual([dialog.props.title,dialog.props.confirmLabel,dialog.props.tone,dialog.props.lines],[de('desired.deleteTitle'),'Konfiguration löschen','danger',[{label:'Konfiguration',value:'Baseline'}]]);assert.ok(dialog.props.body.endsWith('\n\n'+de('desired.deleteKeeps')));});
  dialog.props.onConfirm();await harness.settle();
  check(()=>{assert.deepEqual(calls.find(call=>call.body).body,{action:'delete-config',configId:'config',confirmDelete:true});});
 }
 // The Desired State page: the page tab picks the view; no tab bar, head or gradient button of the panel; the Origin column; the counts.
 {
  const counts=[],views=[];const library={servers:[machine],viewer:owner,demo:false,serverId:undefined,view:'status',onView:view=>views.push(view),onCounts:value=>counts.push(value),origin:device=>'Origin of '+device.name};
  tree=await mount(library);html=harness.html(Panel,library);
  check(()=>{assert.equal(calls[0].url,'/api/desired-state');assert.ok(!harness.walk(tree).some(node=>node.type===Tabs)&&!html.includes('role="tablist"'),'no tab bar of its own');assert.ok(!/<h2 class="sr-only">/.test(html),'no in-panel head');assert.ok(!html.includes('sdx-btn-primary'),'no gradient button');});
  check(()=>{assert.ok(text(html).includes('Origin of VM-01'),'the Origin column');assert.deepEqual(counts.at(-1),{configs:1,runs:1});});
  check(()=>{assert.ok(!/<section class="sdx-card sdx-card-flush"[^>]*><(?:header|div)[^>]*sdx-card-head/.test(html)&&!html.includes('>'+de('tree.devices')+'</h'),'the Device status card has no title that repeats the tab; the table keeps its label');assert.ok(html.includes('aria-label="'+de('tree.devices')+'"'),'the table region is still named');});
  harness.button(tree,de('runbooks.lastRun'))?.props.onClick();
  check(()=>{assert.deepEqual(views,['history'],'a view change inside the panel moves the page tab');});
  check(()=>{assert.equal(harness.html(Panel,{...library,view:'assignments'}),'','the Assignments tab renders nothing of the panel');assert.ok(text(harness.html(Panel,{...library,view:'history'})).includes('VM-01'),'the History view');});
  // Nothing assigned: the KPI tiles have nothing to say, so the row is left out.
  await mount(library,{...data,assignments:[],runs:[]});
  check(()=>{assert.ok(!harness.html(Panel,library).includes('sdx-kpi-row'),'no KPI row of zeros');});
 }
 harness.reset();
 const source=(await import('node:fs')).readFileSync('ui/automation/desired-state-panel.tsx','utf8')+(await import('node:fs')).readFileSync('ui/automation/desired-state-components.tsx','utf8');
 check(()=>{assert.doesNotMatch(source,/variant="destructive"|@\/components\/ui\/|desired\.needsAgent/);});
}
console.log(`PASS: ${checks} Desired-State UI workflow and actual component checks (format drafts/validation, immutable source, assignment conflicts, exact-version status, real queued/failed/compliance states, result detail and persistent feedback), and the kit panel (Unavailable without a request, Tabs with counts, the Check, Apply, Remove and Delete confirmations with the classic bodies).`);
