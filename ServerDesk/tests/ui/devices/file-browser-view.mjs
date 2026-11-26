// Render and drive the real file browser after selection, respecting scope and picker modes.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map();
let states=new Map(),refs=new Map(),stateIndex=0,refIndex=0,actions=[],downloads=[],uploads=[],choices=[],effects=[],toasts=[],failPost=null;
const directory='C:\\Temp',entry={name:'report.txt',path:directory+'\\report.txt',kind:'file',size:1400},folder={name:'Logs',path:directory+'\\Logs',kind:'directory'};
const listing={path:directory,drives:[],entries:[entry,folder],total:2,offset:0,hasMore:false};
const at=Date.now(),server={id:'server-a',name:'Server A',lastSeen:at,revoked:0,management:1,permissions:['files.read','files.write'],snapshot:{protocolVersion:3,agentCapabilities:['list-files']}},viewer={id:'operator',label:'operator@example.test',permissions:[]};
const scopeFor=(s=server,v=viewer)=>JSON.stringify([s.id,v.id,v.permissions?.includes('*')===true,s.permissions??[]]);
// useT() reads the language context; outside a renderer it is the default value.
const react={...React,useContext(context){return context._currentValue;},useCallback(fn){return fn;},useState(initial){const index=stateIndex++;if(!states.has(index))states.set(index,typeof initial==='function'?initial():initial);return [states.get(index),next=>states.set(index,typeof next==='function'?next(states.get(index)):next)];},useRef(initial){const index=refIndex++;if(!refs.has(index))refs.set(index,{current:initial});return refs.get(index);},useMemo(fn){return fn();},useCallback(fn){return fn;},useEffect(fn){effects.push(fn);}};
function load(filename){
 const absolute=path.resolve(filename);if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 const source=fs.readFileSync(absolute,'utf8'),mod={exports:{}};cache.set(absolute,mod);
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;if(id==='react')return react;if(id==='sonner')return {toast:{success:text=>toasts.push(text),error:text=>toasts.push('error:'+text),info:text=>toasts.push('info:'+text)}};if(id==='@/ui/base/api'){const shared=load('ui/base/api.tsx');return {...shared,api:async(url,body)=>{if(body){actions.push(body);if(failPost)throw new Error(failPost);return {id:'job'};}return {job:{state:'succeeded',data:listing,result:null}};}};}if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}return require(id);}
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const FileBrowser=load('ui/devices/remote/file-browser.tsx').default;
const props={server,viewer,demo:false,onUpload:value=>uploads.push(value),onDownload:value=>downloads.push(value),onSelect:value=>choices.push(value)};
function start(selected=entry,s=server,v=viewer){states=new Map([[0,directory],[1,directory],[2,listing],[3,scopeFor(s,v)],[4,selected]]);refs=new Map();actions=[];downloads=[];uploads=[];choices=[];}
const resetIndices=()=>{stateIndex=0;refIndex=0;effects=[];};
function render(next={}){resetIndices();return renderToStaticMarkup(React.createElement(FileBrowser,{...props,...next}));}
function tree(next={}){resetIndices();return FileBrowser({...props,...next});}
function text(node){if(node==null||typeof node==='boolean')return '';if(typeof node!=='object')return String(node);if(Array.isArray(node))return node.map(text).join('');return text(node.props?.children);}
// Children and the element props of the kit Toolbar (filters, actions), the DataTable toolbar and SectionHead actions.
function find(node,predicate){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const value of node){const found=find(value,predicate);if(found)return found;}return null;}if(predicate(node))return node;return find([node.props?.children,node.props?.filters,node.props?.actions,node.props?.toolbar],predicate);}
function button(root,label){const element=find(root,node=>typeof node.props?.onClick==='function'&&text(node)===label);assert.ok(element,`button ${label}`);return element;}
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
// window.confirm is gone (UI-Rework 13b): a call would throw here.
globalThis.window={dispatchEvent(){}};
/** The DataTable of the listing in a tree; the row Menu entries of an entry by name. */
function findDeep(node,predicate){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const value of node){const found=findDeep(value,predicate);if(found)return found;}return null;}if(predicate(node))return node;return findDeep([node.props?.children,node.props?.filters,node.props?.actions,node.props?.toolbar],predicate);}
const listingOf=root=>findDeep(root,node=>Array.isArray(node.props?.columns)&&Array.isArray(node.props?.rows));
const entriesOf=(root,name)=>{const table=listingOf(root),row=table.props.rows.find(item=>item.name===name),menu=table.props.columns.find(column=>column.id==='actions').cell(row);return menu.props.entries;};
const labelsOf=list=>list.map(item=>item.separator?'—':item.label);
const entry_=(list,label)=>list.find(item=>item.label===label);
start();let html=render();
// no classic panel, the SectionHead with the hidden title and the description; no HTTPS or ReadOnly chip.
assert.ok(!/class="panel|panel-heading|file-secure|>HTTPS<|file-selection/.test(html),'no .panel, panel heading, HTTPS chip or selection box');
assert.match(html,/^<section class="file-browser" aria-label="Dateibrowser"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 class="sr-only">Dateien<\/h2><p>[^<]+<\/p><\/div><\/header>/,'SectionHead hideTitle with files.description');
assert.ok(!html.includes('sdx-notice'),'with files.write in Management mode: no panel notice');
// the listing DataTable with sort heads and the kit Toolbar with search, Folder and Upload.
assert.match(html,/<div class="sdx-table-wrap" role="region" aria-label="Dateibrowser"/,'the listing is one DataTable labelled files.browser');
assert.deepEqual([...html.matchAll(/<th scope="col"[^>]*aria-sort="[a-z]+"><button[^>]*>([^<]+)</g)].map(match=>match[1]),['Name','Größe','Zuletzt geändert'],'sort heads for Name, Size and Last modified');
assert.ok(!/<select/.test(html),'the sort select is gone');
assert.deepEqual([...html.matchAll(/class="sdx-row-open"[^>]*><span class="file-entry"[^>]*><svg[^>]*class="lucide lucide-(folder|file)/g)].map(match=>match[1]),['folder','file'],'folders first, each with its icon');
const toolbarHtml=html.slice(html.indexOf('class="sdx-toolbar file-toolbar"'),html.indexOf('<div class="sdx-table-wrap"'));
for(const label of ['Ordner','Hochladen'])assert.ok(toolbarHtml.includes(label),label+' is in the kit Toolbar');
assert.ok(toolbarHtml.includes('sdx-toolbar-search'),'the Toolbar search');
assert.ok(/<div class="sdx-table-foot"><p>2 Einträge<\/p><\/div>/.test(html),'the foot shows the entries sentence');
// one row Menu per entry with its entries and blocked reasons.
const rootTree=tree();
assert.deepEqual(labelsOf(entriesOf(rootTree,'report.txt')),['Herunterladen','Umbenennen','—','Löschen'],'a file: Download, Rename, separator, Delete');
assert.deepEqual(labelsOf(entriesOf(rootTree,'Logs')),['Öffnen','Umbenennen','—','Löschen'],'a folder: Open, Rename, separator, Delete');
assert.equal(entry_(entriesOf(rootTree,'report.txt'),'Löschen').danger,true,'Delete is danger');
entry_(entriesOf(rootTree,'report.txt'),'Herunterladen').onSelect();button(rootTree,'Hochladen').props.onClick();assert.deepEqual(downloads,[entry.path]);assert.deepEqual(uploads,[directory]);
entry_(entriesOf(rootTree,'report.txt'),'Umbenennen').onSelect();assert.deepEqual(states.get(11),{kind:'rename',path:entry.path,name:entry.name},'rename freezes the target of its row');
start();entry_(entriesOf(tree(),'Logs'),'Öffnen').onSelect();assert.equal(states.get(0),folder.path,'Open navigates into the folder');
start();listingOf(tree()).props.onOpen(folder);assert.equal(states.get(0),folder.path,'a row click opens a folder');
start();listingOf(tree()).props.onOpen(entry);assert.equal(states.get(0),directory,'a row click on a file opens nothing');
// Delete asks through the ConfirmDialog; Cancel sends nothing, Confirm queues the job.
start();entry_(entriesOf(tree(),'report.txt'),'Löschen').onSelect();assert.equal(states.get(13),entry,'Delete opens the confirmation');assert.equal(actions.length,0,'nothing is sent before the confirmation');
const dialog=find(tree(),node=>node.props?.confirmLabel==='Löschen');
assert.deepEqual([dialog.props.open,dialog.props.title,dialog.props.lines,dialog.props.body,dialog.props.tone],[true,'report.txt löschen?',[{label:'Gerät',value:'Server A'},{label:'Pfad',value:entry.path,mono:true}],'Das löscht den Eintrag endgültig. Einen Ordner kannst du nur löschen, wenn er leer ist.','danger'],'the dialog: title, Device and Path lines, description, danger');
dialog.props.onOpenChange(false);assert.equal(states.get(13),null,'Cancel closes it');await drain();assert.equal(actions.length,0,'Cancel sends nothing');
entry_(entriesOf(tree(),'report.txt'),'Löschen').onSelect();find(tree(),node=>node.props?.confirmLabel==='Löschen').props.onConfirm();await drain();
assert.equal(actions[0].kind,'delete-file');assert.deepEqual(actions[0].params,{path:entry.path});assert.equal(actions[0].confirm,true,'Confirm queues the job with explicit confirmation');
// Scope change: the old listing is hidden, Folder and Upload wait for the new listing.
start();html=render({server:{...server,id:'server-b'}});assert.ok(!html.includes('report.txt'),'the old listing is hidden after a device change');const stale=tree({server:{...server,id:'server-b'}});assert.equal(button(stale,'Ordner').props.blocked,'Ordner wird geladen','old directory cannot create on a new device: Folder waits for the listing');assert.equal(button(stale,'Hochladen').props.blocked,'Ordner wird geladen','old directory cannot upload on a new device');assert.match(render({server:{...server,id:'server-b'}}),/sdx-skeleton-table/,'the new device loads its folder');
// Rights, transfer, no folder.
const reader={...viewer,id:'reader',permissions:[]},readServer={...server,management:0,permissions:['files.read']};start(entry,readServer,reader);html=render({server:readServer,viewer:reader});
assert.ok(html.includes('Dir fehlt auf diesem Gerät die Berechtigung dafür. Dateien durchsuchen und herunterladen kannst du weiter.'),'without files.write: one PanelUnavailable with files.readOnly');
const readerTree=tree({server:readServer,viewer:reader});assert.equal(entry_(entriesOf(readerTree,'report.txt'),'Herunterladen').blocked,undefined,'download stays free for a reader');
for(const label of ['Umbenennen','Löschen'])assert.equal(entry_(entriesOf(readerTree,'report.txt'),label).blocked,'Dir fehlt die Berechtigung, auf diesem Gerät Dateien zu ändern.',label+' stays visible and names the missing right');
assert.equal(button(readerTree,'Ordner').props.blocked,'Dir fehlt die Berechtigung, auf diesem Gerät Dateien zu ändern.','Folder names the missing right');
start();{const busyTree=tree({transferBusy:true});for(const label of ['Herunterladen','Umbenennen','Löschen'])assert.equal(entry_(entriesOf(busyTree,'report.txt'),label).blocked,'Warte, bis die laufende Übertragung endet.',label+' respects transfer busy with the reason');for(const label of ['Ordner','Hochladen'])assert.equal(button(busyTree,label).props.blocked,'Warte, bis die laufende Übertragung endet.',label+' respects transfer busy with the reason');}
start();states.set(0,null);states.set(1,'');states.set(2,{...listing,path:null,drives:[{name:'C:',label:'System',kind:'fixed',ready:true,freeBytes:25*1024**3,totalBytes:100*1024**3}],entries:[]});states.set(4,null);{const drives=tree();assert.equal(button(drives,'Ordner').props.blocked,'Öffne zuerst einen Ordner.','no folder open: Folder names the next step');assert.equal(find(drives,node=>node.props?.label==='Übergeordneten Ordner öffnen')?.props.blocked,'Öffne zuerst einen Ordner.','the parent button is blocked on the drive list');}
// drive cards with a kit Meter and IEC sizes.
html=render();assert.match(html,/<button type="button" class="file-drive sdx-lift">.*<span class="sdx-meter sdx-meter-normal sdx-meter-sm" role="meter" aria-label="C: 25.GiB frei von 100.GiB" aria-valuemin="0" aria-valuemax="100" aria-valuenow="75">/,'a drive card shows its used space as a kit Meter');assert.ok(!html.includes('<progress'),'no native progress');
// Picker mode: a visible title with its close button, a row click selects, Choose returns it.
start();html=render({pickerMode:'file',onClose:()=>{}});assert.ok(!html.includes('Herunterladen')&&!html.includes('Umbenennen')&&!html.includes('Löschen'),'the picker has no change actions');
assert.match(html,/<h3>Pfad auswählen<\/h3>/,'the picker keeps a visible title');assert.ok(html.includes('aria-label="Pfadauswahl schließen"'),'and its close button');
start(null);listingOf(tree({pickerMode:'file'})).props.onOpen(entry);assert.equal(states.get(4),entry,'a row click selects the entry');html=render({pickerMode:'file'});assert.ok(html.includes('sdx-row-highlight'),'the selected row is highlighted');button(tree({pickerMode:'file'}),'Auswählen').props.onClick();assert.deepEqual(choices,[entry.path],'file picker returns the selected file');
start(folder);assert.deepEqual(labelsOf(entriesOf(tree({pickerMode:'folder'}),'Logs')),['Öffnen'],'the folder picker keeps Open for folders');button(tree({pickerMode:'folder'}),'Auswählen').props.onClick();assert.deepEqual(choices,[folder.path]);
// Choose: a spinner while the agent works, a stated reason without a listing or a choice, never native disabled.
start();states.set(7,true);{const choose=button(tree({pickerMode:'file'}),'Auswählen');assert.equal(choose.props.loading,true,'busy: Choose shows its spinner');assert.ok(!('disabled' in choose.props),'busy: no native disabled on Choose');}
start();states.set(2,null);states.set(3,'');assert.equal(button(tree({pickerMode:'folder'}),'Auswählen').props.blocked,'Ordner wird geladen','no listing with a path open: Choose names the loading folder');
start();states.set(0,null);states.set(1,'');states.set(2,null);states.set(3,'');assert.equal(button(tree({pickerMode:'folder'}),'Auswählen').props.blocked,'Laufwerke werden geladen','no listing on the drive list: Choose names the loading drives');
start(null);{const choose=button(tree({pickerMode:'file'}),'Auswählen');assert.equal(choose.props.blocked,'Wähle zuerst eine Datei aus.','a listing without a file: Choose names the next step');assert.equal(choose.props.loading,false,'and shows no spinner');}
start(null);assert.equal(button(tree({pickerMode:'folder'}),'Auswählen').props.blocked,undefined,'the folder picker can return the open folder');
start();states.set(0,null);states.set(1,'');states.set(2,{...listing,path:null,drives:[],entries:[]});states.set(4,null);assert.equal(button(tree({pickerMode:'folder'}),'Auswählen').props.blocked,'Öffne zuerst einen Ordner.','the folder picker on the drive list names the next step');
// The path form: the text Open above 760px, an icon-only Open (FolderOpen, framed) at 760px or narrower; both submit the form.
const {Btn:KitBtn,IconBtn:KitIconBtn}=load('ui/kit/kit.tsx');
const pathForm=root=>find(root,node=>node.type==='form'&&node.props?.className==='file-path-form');
const formControls=form=>{const found=[];const walk=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}if(node.type===KitBtn||node.type===KitIconBtn)found.push(node);walk(node.props?.children);};walk(form.props.children);return found;};
start();{const form=pathForm(tree()),controls=formControls(form);assert.equal(controls.length,1,'one submit control in the path form');assert.equal(controls[0].type,KitBtn,'wide: the text Btn');assert.deepEqual([controls[0].props.type,controls[0].props.size,text(controls[0])],['submit','sm','Öffnen'],'wide: a small submit Btn "Öffnen"');}
start();states.set(14,true);{const form=pathForm(tree()),controls=formControls(form);assert.equal(controls.length,1,'narrow: still one submit control');const open=controls[0];assert.equal(open.type,KitIconBtn,'narrow: an IconBtn, no text Btn');assert.deepEqual([open.props.type,open.props.label,open.props.className,open.props.icon],['submit','Öffnen','sdx-icon-btn-framed',require('lucide-react').FolderOpen],'narrow: a framed FolderOpen submit IconBtn labelled "Öffnen", like Back and Refresh');assert.equal(open.props.disabled,false,'narrow: free while idle');
 states.set(1,'  D:\Data  ');pathForm(tree()).props.onSubmit({preventDefault(){}});assert.equal(states.get(0),'D:\Data','narrow: submitting the form opens the trimmed path');
 states.set(1,'');pathForm(tree()).props.onSubmit({preventDefault(){}});assert.equal(states.get(0),null,'an empty path opens the drive list');}
start();states.set(14,true);states.set(7,true);assert.equal(formControls(pathForm(tree()))[0].props.disabled,true,'narrow: busy keeps the native disabled of the path input');
start();states.set(2,{...listing,entries:[{...entry,blocked:true}]});assert.equal(entry_(entriesOf(tree(),'report.txt'),'Herunterladen').blocked,'Geschützter Name, Reparse Point oder nicht zugänglich','blocked entries keep their actions with the reason');
// States: the concrete reason instead of a listing, a failed listing with "Try again".
start();html=render({server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}});
assert.match(html,/class="sdx-notice sdx-notice-info" role="status"/,'without list-files: an info notice');
assert.ok(html.includes('Dieser Agent kann noch keine Dateien anzeigen. Aktualisiere den Agent unter Agents.'),'with the new agent sentence');
assert.equal((html.match(/<svg/g)??[]).length,1,'its icon sits in the notice row');
start();html=render({demo:true});assert.ok(html.includes('Bei Beispielgeräten nicht möglich.'),'a sample device names the demo reason');assert.ok(!html.includes('zugewiesenen Rechte'));
const noRead={...server,permissions:['files.write']};start(entry,noRead);html=render({server:noRead});assert.ok(html.includes('Dir fehlt die Berechtigung, auf diesem Gerät Dateien anzuzeigen.'),'without files.read: the right sentence');
const offline={...server,lastSeen:at-180000};start(entry,offline);html=render({server:offline});
assert.ok(html.includes('Das ist wieder verfügbar, sobald das Gerät online ist.'),'offline: the offline sentence in place of the listing');
assert.ok(!html.includes('file-empty')&&!html.includes('class="file-content"'),'offline: no file-empty text and no listing');
assert.match(html,/class="sdx-toolbar file-toolbar"/,'the kit Toolbar stays');
start();states.set(2,null);states.set(3,'');states.set(8,'Der Agent hat nicht geantwortet.');html=render();
assert.match(html,/class="sdx-notice sdx-notice-danger" role="alert"/,'a failed listing: a danger notice');
assert.ok(html.includes('Der Agent hat nicht geantwortet.')&&html.includes('Erneut versuchen'),'with the error and "Try again"');
assert.ok(!html.includes('sdx-skeleton'),'no skeleton next to the error');
const retryButton=find(tree(),node=>node.props?.tone==='danger')?.props.action;assert.equal(text(retryButton),'Erneut versuchen');assert.ok(retryButton,'the retry button');
const revision=states.get(10);retryButton.props.onClick();assert.equal(states.get(8),'','the error clears');assert.equal(states.get(10),revision+1,'the current folder is listed again');
tree();const listingEffect=effects.find(effect=>String(effect).includes("'list-files'"));assert.ok(listingEffect,'the listing effect');listingEffect();await drain();
assert.deepEqual(actions.map(action=>[action.kind,action.params.path]),[['list-files',directory]],'"Try again" starts a new list-files job for the current folder');
start();states.set(8,'Der Agent hat nicht geantwortet.');html=render();assert.ok(html.includes('Angezeigt wird der zuletzt geladene Stand.'),'an earlier listing stays with the stale note');assert.match(html,/report\.txt/);
start();states.set(2,null);states.set(3,'');html=render();assert.match(html,/sdx-skeleton-table/,'the first load of a folder uses the kit skeleton (table)');
start();states.set(0,null);states.set(1,'');states.set(2,null);states.set(3,'');html=render();assert.match(html,/sdx-skeleton-cards/,'the drive list loads as cards');
assert.ok(!fs.readFileSync('ui/devices/remote/file-browser.tsx','utf8').includes("t('files.offline')"),'the offline text line is gone');
// The Files subarea (file-panel.tsx) names the same reasons before the browser.
const FilePanel=load('ui/devices/remote/file-panel.tsx').default;
start();html=renderToStaticMarkup(React.createElement(FilePanel,{server,viewer,demo:true}));assert.ok(html.includes('Bei Beispielgeräten nicht möglich.')&&!html.includes('zugewiesenen Rechte'),'Files in demo mode: the demo sentence');
const noFiles={...server,permissions:[]};start(entry,noFiles);html=renderToStaticMarkup(React.createElement(FilePanel,{server:noFiles,viewer,demo:false}));assert.ok(html.includes('Dir fehlt die Berechtigung, auf diesem Gerät Dateien anzuzeigen.'),'Files without a file right: the right sentence');
// A failed file action is a toast, not a panel notice.
start();toasts=[];failPost='Die Datei ist gesperrt.';entry_(entriesOf(tree(),'report.txt'),'Löschen').onSelect();find(tree(),node=>node.props?.confirmLabel==='Löschen').props.onConfirm();await drain();failPost=null;
assert.deepEqual(toasts,['error:Die Datei ist gesperrt.'],'a failed delete shows toast.error');assert.equal(states.get(8),'','and no danger notice');

const css=fs.readFileSync('ui/devices/remote/file-browser.css','utf8');assert.doesNotMatch(css,/\.file-path-form button\s*\{\s*display:\s*none/,'the path form keeps its Open button at 760px or narrower');
// The legacy .v3-form rules leave the kit Switch alone: no 16px checkbox sizing on role="switch", no muted field-label look on its row.
for(const name of ['ui/styles/classic-forms.css','ui/styles/classic-console.css']){const legacy=fs.readFileSync(name,'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
 const checkboxRules=[...legacy.matchAll(/([^{}]*\.v3-form input:is\(\[type="?checkbox"?\][^{}]*)\{([^}]*)\}/g)];assert.ok(checkboxRules.length>0,name+': the legacy checkbox sizing rule exists');
 for(const [,selector,body] of checkboxRules)if(/width:\s*16px|flex:\s*0 0 16px/.test(body))assert.match(selector,/:where\(:not\(\[role="?switch"?\]\)\)/,name+': the 16px checkbox rule excludes role="switch" without raising its specificity');
 const labelRules=[...legacy.matchAll(/(^|[}\n])\s*([^{}]*\.v3-form label(?![.\w-])[^{}]*)\{([^}]*)\}/g)].filter(match=>/font-size|color|display/.test(match[3]));assert.ok(labelRules.length>0,name+': the legacy label rule exists');
 for(const match of labelRules)assert.match(match[2],/:where\(:not\(\.sdx-switch-field\s*>\s*label\)\)/,name+': the legacy label look skips the kit switch row');}
assert.match(fs.readFileSync('ui/devices/remote/file-transfers.css','utf8'),/\.transfer-upload-body>\.sdx-switch-field\{justify-self:start;max-width:100%\}/,'the upload switch keeps its natural width');
assert.match(fs.readFileSync('ui/styles/classic-panels.css','utf8'),/input\[type="checkbox"\]\[role="switch"\] \{[^}]*flex-shrink: 0;[^}]*width: 38px;[^}]*height: 22px;/,'the switch track: 38x22, never shrinks');assert.match(css,/\.file-navigation \{ display: flex;/,'the path navigation row');assert.doesNotMatch(css,/\.file-filter|data-slot="input"/,'the classic filter field is gone');
// Kit-only controls: no shadcn part, the filter is the kit Toolbar search, the path field is Field-bound.
for(const source of ['ui/devices/remote/file-browser.tsx','ui/devices/remote/file-panel.tsx'].map(name=>fs.readFileSync(name,'utf8')))assert.doesNotMatch(source,/@\/components\/ui\/|<Button\b|<Input\b/,'no shadcn Button or Input');
const browserSource=fs.readFileSync('ui/devices/remote/file-browser.tsx','utf8');assert.ok(browserSource.includes("search={{value:filter,onChange:setFilter,label:t('files.filterLabel')"),'the filter is the Toolbar search labelled files.filterLabel');assert.match(browserSource,/<Field label=\{t\('files\.windowsPath'\)\}/,'the path field is Field-bound');
// no window.confirm, no fileBytes, no classic panel in the Files sources.
assert.ok(/<Btn size="sm" variant="primary" loading=\{busy\} blocked=\{chooseBlocked\} onClick=.*?>\{t\('management\.updates\.select'\)\}<\/Btn>/.test(browserSource),'Choose: loading and blocked');assert.doesNotMatch(browserSource.slice(browserSource.indexOf('<footer className="file-footer">')),/disabled=/,'Choose has no native disabled');
assert.doesNotMatch(fs.readFileSync('ui/devices/remote/file-browser.tsx','utf8'),/window\.confirm|fileBytes|className="panel|panel-heading|<table|<select|<progress/,'file-browser.tsx: kit parts only');
assert.doesNotMatch(fs.readFileSync('ui/devices/remote/file-panel.tsx','utf8'),/window\.confirm|fileBytes|className="panel|panel-heading|disabled=\{!localFiles/,'file-panel.tsx: no window.confirm, fileBytes, classic panel or native disabled Upload (the transfer progress notice is out of scope)');
console.log('PASS: Files on the kit: SectionHead and PanelUnavailable, drive cards with a Meter, the listing DataTable with sort heads, folders first and paging, one row Menu per entry with its blocked reasons, the delete ConfirmDialog, scope/busy/transfer guards, the pickers with Choose loading and blocked, the path form Open at every width, and the legacy .v3-form rules that leave the kit Switch alone.');
