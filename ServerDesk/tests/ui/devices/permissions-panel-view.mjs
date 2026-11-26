// The Permissions view (ScopedPermissionEditor, ui/devices/configuration/permissions-tab.tsx) on the scope subtab pattern, run on hook
// cells (tests/support/panel-harness.mjs) with a stubbed api and the real step-up hook (ui/session/step-up-retry.ts) and data hook
// (ui/settings/rbac-data.ts): the sr-only head with "Add assignment" as its only action (secondary, no refresh IconBtn), one
// Toolbar search, the Direct card with the row Menu "Remove assignment…" (blocked for Entra rows), the Inherited card with
// InheritedOrigin, the muted rows and the row Menu "Open origin", the cause-specific Empty states, demo, the remove
// confirmation with the body after the step-up, its in-scope guard and its drop (not only hide) on a scope change, the
// Direct Empty with the head's "Add assignment" (same label, icon, reason and condition), the add Drawer with kit Selects
// and "Assign role", refreshKey and prefill.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
// The view listens for the session lock on window; a global window only while effects and cleanups run, because radix treats it as a browser while rendering.
const windowStub={addEventListener(){},removeEventListener(){},dispatchEvent(){}};
const withWindow=async fn=>{globalThis.window=windowStub;try{return await fn();}finally{delete globalThis.window;}};
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const calls=[];let reply=null;
const MfaStepUp=()=>null;
const stubs={'@/ui/base/api':{api:(url,body)=>{calls.push({url,body});return Promise.resolve(body?{ok:true}:structuredClone(reply));},ApiError,message:error=>error.message},'@/ui/session/mfa-step-up':{MfaStepUp},'@/ui/base/http':{SESSION_LOCK_EVENT:'test:lock'}};
const harness=panelHarness({hooked:['ui/devices/configuration/permissions-tab.tsx','ui/settings/rbac-data.ts','ui/session/step-up-retry.ts','ui/shell/page-frame.ts'],stubs});
const {ScopedPermissionEditor:Editor}=harness.load('ui/devices/configuration/permissions-tab.tsx'),{ConfirmDialog}=harness.load('ui/kit/confirm-dialog.tsx'),{InheritedOrigin}=harness.load('ui/kit/inheritance.tsx'),kit=harness.load('ui/kit/kit.tsx'),field=harness.load('ui/kit/field.tsx');
const viewer={id:'owner',userId:'owner',label:'Owner',permissions:['*']};
const users=[{id:'owner',username:'owner',displayName:'Owner',email:null,status:'active'},{id:'reader',username:'reader',displayName:'Reader',email:null,status:'active'},{id:'gone',username:'gone',displayName:'Gone',email:null,status:'disabled'}];
const roles=[{id:'reader-role',name:'Leser',description:'Nur lesen',permissions:['view'],builtIn:false}];
const direct={id:'a-direct',subjectType:'user',subjectId:'reader',roleId:'reader-role',scopeType:'device',scopeId:'web'};
const inheritedAssignment={id:'a-group',subjectType:'user',subjectId:'owner',roleId:'reader-role',scopeType:'devicegroup',scopeId:'g1'};
const globalAssignment={id:'a-global',subjectType:'user',subjectId:'reader',roleId:'reader-role',scopeType:'global',scopeId:'*'};
const base={users,userGroups:[],roles,assignments:[direct,inheritedAssignment,globalAssignment],inherited:[{assignmentId:'a-group',originType:'devicegroup',originId:'g1',effective:true},{assignmentId:'a-global',originType:'global',originId:'*',effective:false,reason:'role'}],deviceGroups:[{id:'g1',name:'Berlin'}],devices:[{id:'web',name:'CT-WEB01'}],permissions:[{id:'view',labelKey:'permission.view'}],canManage:true,canManageUsers:true,canManageAssignments:true,canManageUserGroups:true,canManageRoles:true};
const opened=[];
let props={viewer,demo:false,onRefresh:()=>{},scope:{type:'device',id:'web'},scopeName:'CT-WEB01',onOpenScope:target=>opened.push(target)};
const render=()=>harness.tree(Editor,props);
const settle=async()=>{render();await withWindow(()=>harness.flush());return render();};
const mount=async(data=base,overrides={})=>{await withWindow(()=>harness.reset());calls.length=0;reply=data;props={...props,...overrides};return settle();};
const markup=()=>harness.html(Editor,props);
const direct_=tree=>harness.table(tree,'Direkte Rollenzuweisungen'),inherited_=tree=>harness.table(tree,'Geerbte Rollenzuweisungen');

// ---- Head, toolbar, cards and columns ----
let tree=await mount(),html=markup();
check(calls[0].url,'/api/rbac?scopeType=device&scopeId=web','the device scope asks with its inherited assignments');
ok(/<h2 id="sd-rbac-permissions-title" class="sr-only">Berechtigungen<\/h2>/.test(html)&&text(html).includes(de('rbac.assignments.description.device')),'the sr-only head and the scope description');
const head=harness.walk(tree).find(node=>node.props?.actions&&node.props.headingId==='sd-rbac-permissions-title').props.actions;
check([head.type,head.props.variant,harness.text(head).trim(),head.props.icon===undefined],[kit.Btn,undefined,'Zuweisung hinzufügen',false],'the head holds only "Add assignment", a secondary Btn with Plus');
ok(!harness.walk(tree).some(node=>node.type===kit.IconBtn),'no refresh IconBtn and no IconBtn in any row');
ok(!html.includes('sdx-btn-primary'),'no gradient primary in the tab');
check(harness.walk(tree).filter(node=>node.props?.search).map(node=>node.props.search.label),['Berechtigungen suchen'],'one Toolbar search above both cards');
check(direct_(tree).props.columns.map(column=>column.label),['Konto oder Benutzergruppe','Rolle','Aktionen'],'Direct: no Scope column, the row menu column');
check(inherited_(tree).props.columns.map(column=>column.label),['Konto oder Benutzergruppe','Rolle','Herkunft','Aktionen'],'Inherited: the origin column and the row menu column');
ok(harness.walk(tree).some(node=>node.type===InheritedOrigin&&node.props.label==='Gerätegruppe: Berlin'),'the inherited row names its origin');
ok(html.indexOf('>Direkt<')<html.indexOf('>Geerbt<'),'the Direct card first, then Inherited');
const actionsColumn=direct_(tree).props.columns.find(column=>column.id==='actions');
check([actionsColumn.hideLabel,actionsColumn.className],[true,'sdx-col-actions'],'the actions column is a hidden-label sdx-col-actions column');

// ---- Muted inherited rows ----
const subjectClass=row=>inherited_(tree).props.columns[0].cell(row).props.className;
check(inherited_(tree).props.rows.map(subjectClass),['sdx-cell-stack','sdx-cell-stack sdx-inherited-ineffective'],'only the non-effective inherited row is muted');

// ---- Row menus ----
const entries=harness.menu(tree,'Aktionen für Reader');
check(entries.map(entry=>[entry.label,entry.danger,entry.blocked]),[['Zuweisung entfernen…',true,undefined]],'the direct row: one danger entry "Remove assignment…"');
const entraRow={...direct,source:'entra'},entraMenu=actionsColumn.cell(entraRow);
check(entraMenu.props.entries[0].blocked,de('rbac.entraAssignmentBlocked'),'an Entra row: remove is blocked with the mapping reason');
const originColumn=inherited_(tree).props.columns.find(column=>column.id==='actions');
originColumn.cell(inherited_(tree).props.rows[0]).props.entries[0].onSelect();
originColumn.cell(inherited_(tree).props.rows[1]).props.entries[0].onSelect();
check(opened,[{type:'group',id:'g1',name:'Berlin'},{type:'global',name:'Alle Geräte'}],'"Open origin" opens the group or All devices');
check(originColumn.cell(inherited_(tree).props.rows[0]).props.entries.map(entry=>entry.label),['Ursprung öffnen'],'the inherited row menu holds "Open origin"');
tree=await mount(base,{onOpenScope:undefined});
check(inherited_(tree).props.columns.some(column=>column.id==='actions'),false,'without onOpenScope the inherited rows have no menu');
props={...props,onOpenScope:target=>opened.push(target)};

// ---- Remove: ConfirmDialog danger with three facts, the body after the step-up ----
tree=await mount();
harness.menu(tree,'Aktionen für Reader')[0].onSelect();tree=render();
const dialog=harness.walk(tree).find(node=>node.type===ConfirmDialog&&node.props.open);
check([dialog.props.title,dialog.props.tone,dialog.props.confirmLabel,dialog.props.lines],['Rollenzuweisung entfernen?','danger','Rollenzuweisung entfernen',[{label:'Konto oder Benutzergruppe',value:'Reader'},{label:'Rolle',value:'Leser'},{label:'Bereich',value:'Gerät: CT-WEB01'}]],'the remove confirmation');
check(dialog.props.body,de('rbac.removeAssignment.body'),'what happens');
dialog.props.onConfirm();tree=render();
let stepUp=harness.walk(tree).find(node=>node.type===MfaStepUp);ok(stepUp.props.open,'the step-up opens before anything is sent');check(calls.length,1,'nothing sent yet');
ok(!harness.walk(tree).some(node=>node.type===ConfirmDialog&&node.props.open),'the confirmation waits behind the step-up');
await withWindow(async()=>{stepUp.props.onVerified({managementToken:'proof'});await harness.settle();});
check(calls[1].body,{action:'delete-assignment',id:'a-direct',managementToken:'proof'},'the body is the classic one');
check(calls[2],{url:'/api/rbac?scopeType=device&scopeId=web',body:undefined},'the data reloads after the change');
ok(harness.toasts.includes(de('rbac.toast.assignmentRemoved')),'a success toast');
tree=render();ok(!harness.walk(tree).some(node=>node.type===ConfirmDialog&&node.props.open),'the confirmation closes');

// ---- A scope change clears a pending removal: back on the first scope the dialog stays closed ----
tree=await mount();
harness.menu(tree,'Aktionen für Reader')[0].onSelect();tree=render();
ok(harness.walk(tree).some(node=>node.type===ConfirmDialog&&node.props.open),'the removal is pending on device web');
const openDialog=()=>harness.walk(render()).some(node=>node.type===ConfirmDialog&&node.props.open);
// The scope change re-runs the data effect, whose cleanup unhooks the session lock listener from window.
const switchScope=async(scope,scopeName)=>{props={...props,scope,scopeName};await withWindow(async()=>{render();await harness.flush();});};
await switchScope({type:'devicegroup',id:'g1'},'Berlin');
ok(!openDialog(),'another scope: no open confirmation');
await switchScope({type:'device',id:'web'},'CT-WEB01');
ok(!openDialog(),'back on device web: the confirmation stays closed');
await withWindow(async()=>{harness.walk(render()).find(node=>node.type===ConfirmDialog).props.onConfirm();await harness.settle();});
check(calls.filter(call=>call.body?.action==='delete-assignment').length,0,'a later confirm sends no delete-assignment');

// ---- Add: a Drawer with kit Selects and "Assign role" ----
tree=await mount();harness.button(tree,'Zuweisung hinzufügen').props.onClick();tree=render();html=markup();
ok(/role="dialog"/.test(html)&&text(html).includes(de('rbac.dialog.addAssignment')),'the add Drawer');
check(harness.walk(tree).filter(node=>node.type===field.Select).length,3,'Type, account and role are kit Selects');
ok(harness.walk(tree).every(node=>node.type!==field.Select||harness.walk(tree).some(parent=>parent.type===field.Field&&parent.props.children===node)),'each Select sits in a Field');
ok(/<dt>Bereich<\/dt><dd>CT-WEB01/.test(html),'the scope as a fact');
const submit=()=>harness.walk(render()).find(node=>node.type===kit.Btn&&node.props.type==='submit');
check([harness.text(submit()).trim(),submit().props.blocked],[de('rbac.assignRole'),de('rbac.blocked.incomplete')],'the submit "Assign role" is blocked until the form is valid');
const select=label=>harness.walk(render()).find(node=>node.type===field.Field&&node.props.label===label).props.children;
select('Konto').props.onChange({target:{value:'reader'}});select('Rolle').props.onChange({target:{value:'reader-role'}});
check(submit().props.blocked,undefined,'a valid form can be sent');
ok(harness.walk(render()).find(node=>node.type===kit.Drawer).props.dirty,'the drawer is dirty once edited');
harness.walk(render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=render();
stepUp=harness.walk(tree).find(node=>node.type===MfaStepUp);check([stepUp.props.open,calls.length],[true,1],'the add waits for the step-up');
stepUp.props.onClose();tree=render();
check([calls.length,harness.walk(tree).find(node=>node.type===kit.Drawer).props.open,select('Konto').props.value],[1,true,'reader'],'cancelling the step-up sends nothing and keeps the drawer with its input');
harness.walk(render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
await withWindow(async()=>{harness.walk(render()).find(node=>node.type===MfaStepUp).props.onVerified({managementToken:'add'});await harness.settle();});
check(calls[1].body,{action:'add-assignment',subjectType:'user',subjectId:'reader',roleId:'reader-role',scopeType:'device',scopeId:'web',managementToken:'add'},'the add body');
ok(harness.toasts.includes('Rolle zugewiesen.'),'the toast "Role assigned."');
check(harness.walk(render()).find(node=>node.type===kit.Drawer).props.open,false,'the drawer closes after the change');

// ---- A missing management token sends nothing ----
tree=await mount();harness.button(tree,'Zuweisung hinzufügen').props.onClick();
select('Konto').props.onChange({target:{value:'reader'}});select('Rolle').props.onChange({target:{value:'reader-role'}});
harness.walk(render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
await withWindow(async()=>{harness.walk(render()).find(node=>node.type===MfaStepUp).props.onVerified({});await harness.settle();});
check([calls.length,harness.toasts.includes('error:'+de('rbac.noManagementToken')),harness.walk(render()).find(node=>node.type===kit.Drawer).props.open],[1,true,true],'a proof without a token toasts rbac.noManagementToken and keeps the drawer');

// ---- Direct Empty by cause ----
tree=await mount({...base,assignments:[inheritedAssignment,globalAssignment]});
check([direct_(tree).props.empty.title,direct_(tree).props.empty.children],[de('rbac.assignments.noDirect'),de('rbac.assignments.noDirectHint')],'inherited rows exist: "no direct" with its hint');
tree=await mount({...base,assignments:[],inherited:[]});
check([direct_(tree).props.empty.title,direct_(tree).props.empty.children],[de('rbac.assignments.noneHere'),de('rbac.assignments.noneHereHint')],'nothing applies: "none here" with its hint');
ok(text(markup()).includes('Zuweisung hinzufügen'),'the empty state offers "Add assignment"');
tree=await mount();harness.walk(tree).find(node=>node.props?.search).props.search.onChange('zzz');tree=render();
check(direct_(tree).props.empty.title,de('rbac.assignments.noMatch'),'no match');
ok(text(markup()).includes('Suche löschen'),'with "Suche löschen"');
tree=await mount(base,{scope:{type:'global'},scopeName:'Alle Geräte'});
check(calls[0].url,'/api/rbac','All devices keeps the plain request');
ok(text(markup()).includes(de('rbac.assignments.description.global')),'the global description');
props={...props,scope:{type:'device',id:'web'},scopeName:'CT-WEB01'};

// ---- The Direct Empty keeps "Add assignment": the same control as the head's, under the same condition ----
const headAction=tree=>harness.walk(tree).find(node=>node.props?.headingId==='sd-rbac-permissions-title').props.actions;
for(const data of [{...base,assignments:[],inherited:[]},{...base,assignments:[inheritedAssignment,globalAssignment]}]){
 tree=await mount(data);
 const action=direct_(tree).props.empty.action,head=headAction(tree);
 check([action.type,harness.text(action).trim(),action.props.icon.displayName,action.props.blocked],[head.type,harness.text(head).trim(),head.props.icon.displayName,head.props.blocked],'the Empty action is the head action: label, icon and blocked');
 check([harness.text(head).trim(),head.props.icon.displayName],[de('rbac.addAssignment'),'Plus'],'"Add assignment" with Plus');
}
tree=await mount({...base,assignments:[direct],inherited:[]});harness.menu(tree,'Aktionen für Reader')[0].onSelect();tree=render();
harness.walk(tree).find(node=>node.type===ConfirmDialog&&node.props.open).props.onConfirm();tree=render();
check([harness.walk(tree).find(node=>node.type===kit.Btn&&node.props.icon?.displayName==='Plus').props.blocked,headAction(tree).props.blocked],[de('fleet.menu.saving'),de('fleet.menu.saving')],'while a change waits, the head action says why');
harness.walk(tree).find(node=>node.type===MfaStepUp).props.onClose();
tree=await mount({...base,assignments:[],inherited:[],canManageAssignments:false});
check([headAction(tree),direct_(tree).props.empty.action],[undefined,undefined],'without the assignment right neither the head nor the Empty shows "Add assignment"');
tree=await mount({...base,assignments:[],inherited:[]});harness.walk(tree).find(node=>node.props?.search).props.search.onChange('zzz');tree=render();
check([direct_(tree).props.empty.action.type===harness.load('ui/kit/analysis-tab.tsx').ResetAction,direct_(tree).props.empty.action.props.label,!!headAction(tree)],[true,'Suche löschen',true],'with a search that matches nothing the Empty offers only "Clear search"');
ok(/Tags and\s*\/\/ Notification rules, the Empty keeps the creating action/.test((await import('node:fs')).readFileSync('ui/devices/configuration/permissions-tab.tsx','utf8')),'the directEmpty comment names the decision and the two other tabs');

// ---- The in-scope guard: a confirm whose assignment is no longer direct here sends nothing ----
tree=await mount(base,{refreshKey:0});
harness.menu(tree,'Aktionen für Reader')[0].onSelect();tree=render();
reply={...base,assignments:[{...direct,scopeType:'devicegroup',scopeId:'g1'},inheritedAssignment,globalAssignment]};
props={...props,refreshKey:1};tree=await settle();
const staleDialog=harness.walk(tree).find(node=>node.type===ConfirmDialog&&node.props.open);
ok(staleDialog,'the confirmation stays open over the reload');
staleDialog.props.onConfirm();tree=render();
check([harness.walk(tree).find(node=>node.type===MfaStepUp).props.open,calls.filter(call=>call.body).length],[false,0],'the stale assignment is refused: no step-up and nothing sent');
props={...props,refreshKey:undefined};reply=base;

// ---- refreshKey: a new GET, the cards stay ----
tree=await mount(base,{refreshKey:0});check(calls.length,1,'refreshKey loads nothing on mount itself');
let pending;stubs['@/ui/base/api'].api=(url,body)=>{calls.push({url,body});if(body)return Promise.resolve({ok:true});return new Promise(resolve=>{pending=()=>resolve(structuredClone(reply));});};
props={...props,refreshKey:1};await settle();
check(calls.length,2,'a new refreshKey sends one GET');
html=markup();ok(html.includes('Direkte Rollenzuweisungen')&&!html.includes('sdx-skeleton'),'the loaded cards stay visible without a skeleton while it runs');
pending();await withWindow(()=>harness.settle());
stubs['@/ui/base/api'].api=(url,body)=>{calls.push({url,body});return Promise.resolve(body?{ok:true}:structuredClone(reply));};
props={...props,refreshKey:undefined};

// ---- Prefill: once, with the account chosen and the focus on Role ----
const done=[];
const prefill={subjectType:'user',subjectId:'reader'};
tree=await mount(base,{scope:{type:'global'},scopeName:'Alle Geräte',prefill,onPrefillDone:()=>done.push('done')});
// React renders again at once after a state change in the render; the harness does it by hand.
render();await withWindow(()=>harness.flush());tree=render();
check([harness.walk(tree).find(node=>node.type===kit.Drawer).props.open,select('Konto').props.value,select('Rolle').props.autoFocus,select('Typ').props.autoFocus],[true,'reader',true,false],'the prefill opens the drawer with the account chosen and the focus on Role');
check(done,['done'],'onPrefillDone runs once');
harness.walk(tree).find(node=>node.type===kit.Drawer).props.onClose();tree=render();await withWindow(()=>harness.flush());tree=render();
check([harness.walk(tree).find(node=>node.type===kit.Drawer).props.open,done.length],[false,1],'the same prefill does not open the drawer again');
tree=await mount(base,{prefill:{subjectType:'user',subjectId:'unknown'},onPrefillDone:()=>done.push('unknown')});
check([harness.walk(render()).find(node=>node.type===kit.Drawer).props.open,select('Konto').props.value],[true,''],'an account that is not in the data opens the drawer with no account chosen');
props={...props,scope:{type:'device',id:'web'},scopeName:'CT-WEB01',prefill:undefined,onPrefillDone:undefined};

// ---- Demo ----
await withWindow(()=>harness.reset());calls.length=0;props={...props,demo:true};html=markup();
ok(text(html).includes(de('rbac.demo'))&&/sdx-notice-info/.test(html)&&!html.includes('role="region"'),'demo: Unavailable with the demo sentence and no tables');
const demoHead=harness.walk(render()).find(node=>node.props?.headingId==='sd-rbac-permissions-title').props.actions;
check(demoHead.props.blocked,de('kit.unavailable.demo'),'demo: "Add assignment" is blocked with the demo reason');
check(calls.length,0,'demo sends no request');
await withWindow(()=>harness.reset());
console.log(`PASS permissions panel view (${checks} checks): the head with the one secondary "Add assignment", one search, Direct and Inherited cards with row menus, muted inherited rows, cause-specific empty states, the remove confirmation with the classic body after the step-up, the add Drawer with kit Selects and "Assign role", refreshKey, prefill and demo.`);
