// Settings › Accounts, User groups and Roles on the kit (ui/settings/settings-accounts.tsx, settings-user-groups.tsx,
// settings-roles.tsx), run on hook cells (tests/support/panel-harness.mjs) with a stubbed api, the real data hook
// (ui/settings/rbac-data.ts) and the real step-up hook (ui/session/step-up-retry.ts): the frame header with its primary and blocked
// reasons in every state, the SettingsPage body from the one state ladder (ui/settings/rbac-body.tsx: FirstLoad,
// LoadFailed, Unavailable, stale data), demo, the frame refresh, the tables (columns, tabular count columns, cards,
// entrance, foot, empty states), the row menus (order, danger, separators, blocked reasons), the drawers (fields, dirty,
// submit labels, blocked reasons, bodies, the role description textarea), the create icons, the confirmations through
// useRbacConfirm (verbs, tones, hidden during the step-up, one change, closed after it), the toasts, the one-time link
// Dialog with CopyValue and the "Assign role" toast action, and the source rules of the shared confirm and generation
// guards.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import React from 'react';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const windowStub={addEventListener(){},removeEventListener(){},dispatchEvent(){}};
const withWindow=async fn=>{globalThis.window=windowStub;try{return await fn();}finally{delete globalThis.window;}};
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const calls=[];let respond=null;
const MfaStepUp=()=>null;
const stubs={'@/ui/base/api':{api:(url,body)=>{calls.push({url,body});return respond(url,body);},ApiError,message:error=>error.message},'@/ui/session/mfa-step-up':{MfaStepUp},'@/ui/base/http':{SESSION_LOCK_EVENT:'test:lock'}};
const harness=panelHarness({hooked:['ui/settings/settings-accounts.tsx','ui/settings/settings-user-groups.tsx','ui/settings/settings-roles.tsx','ui/settings/rbac-data.ts','ui/session/step-up-retry.ts','ui/shell/page-frame.ts'],stubs});
const AccountsPage=harness.load('ui/settings/settings-accounts.tsx').default,UserGroupsPage=harness.load('ui/settings/settings-user-groups.tsx').default,RolesPage=harness.load('ui/settings/settings-roles.tsx').default;
const kit=harness.load('ui/kit/kit.tsx'),{ConfirmDialog,Dialog}=harness.load('ui/kit/confirm-dialog.tsx'),field=harness.load('ui/kit/field.tsx'),analysis=harness.load('ui/kit/analysis-tab.tsx');
const owner={id:'owner',userId:'owner',label:'Owner',permissions:['*']};
const users=[{id:'owner',username:'owner',displayName:'Owner',email:'owner@example.test',status:'active',mfaEnabled:true,passwordSet:true},{id:'ada',username:'ada',displayName:'Ada',email:null,status:'invited',mfaEnabled:false,passwordSet:false},{id:'dora',username:'dora',displayName:'Dora',email:null,status:'disabled',mfaEnabled:true,passwordSet:true},{id:'entra-user',username:'entra.1',displayName:'Erik Entra',email:'erik@contoso.example',status:'active',identitySource:'entra'}];
const groups=[{id:'ops',name:'Operations',description:'Support team',enabled:true,userIds:['owner']},{id:'old',name:'Altgruppe',description:'',enabled:false,userIds:[]}];
const rolePermissions=[{id:'view',labelKey:'permission.view'},{id:'terminal',labelKey:'permission.terminal'},{id:'alerts.manage',labelKey:'permission.alerts.manage'},{id:'portal.users.manage',labelKey:'permission.portal.users.manage'}];
const roles=[{id:'builtin-reader',name:'Reader',description:'Nur lesen',permissions:['view'],builtIn:true},{id:'helpdesk',name:'Helpdesk',description:'',permissions:['view','alerts.manage','legacy.right'],builtIn:false},{id:'assigned',name:'Zugewiesen',description:'',permissions:['view'],builtIn:false}];
const base={users,userGroups:groups,roles,assignments:[{id:'a1',subjectType:'user',subjectId:'owner',roleId:'assigned',scopeType:'global',scopeId:'*'}],deviceGroups:[],devices:[],permissions:rolePermissions,canManage:true,canManageUsers:true,canManageAssignments:true,canManageUserGroups:true,canManageRoles:true};
const headers=[];let refreshCount=0;
const frame=()=>({header:primary=>{headers.push(primary);return React.createElement('header',{className:'sdx-page-head'},primary);},refresh:refreshCount,tab:'',onTab(){}});
const assigned=[];
let Page=AccountsPage,props={};
const render=()=>{headers.length=0;return harness.tree(Page,{...props,frame:frame()});};
const html=()=>{headers.length=0;return harness.html(Page,{...props,frame:frame()});};
const ready=(value=base)=>(url,body)=>body?Promise.resolve({ok:true}):Promise.resolve(structuredClone(value));
async function mount(Component,{data=base,viewer=owner,demo=false,answer}={}){
 await withWindow(()=>harness.reset());calls.length=0;refreshCount=0;Page=Component;respond=answer??ready(data);
 props={viewer,demo,onRefresh:()=>{},onAssignRole:id=>assigned.push(id)};
 render();await withWindow(()=>harness.flush());return render();
}
const flush=async()=>{render();await withWindow(()=>harness.flush());return render();};
const primary=()=>headers[0];
const body=tree=>harness.walk(tree).find(node=>node.type===kit.SettingsPage);
const table=tree=>harness.table(tree);
const drawer=tree=>harness.walk(tree).find(node=>node.type===kit.Drawer&&node.props.open);
const submit=tree=>harness.walk(tree).find(node=>node.type===kit.Btn&&node.props.type==='submit');
const fieldControl=(tree,label)=>harness.walk(tree).find(node=>node.type===field.Field&&(node.props.label===label||typeof node.props.label==='object'&&harness.text(node.props.label).startsWith(label)))?.props.children;
const openConfirm=tree=>harness.walk(tree).find(node=>node.type===ConfirmDialog&&node.props.open);
const verify=async token=>{await withWindow(async()=>{harness.walk(render()).find(node=>node.type===MfaStepUp).props.onVerified({managementToken:token});await harness.settle();});return render();};

// ======== Accounts ========
// ---- The frame header in every state ----
let tree=await mount(AccountsPage,{answer:()=>new Promise(()=>{})});
check(headers.length,1,'first load: one header call');
check([harness.text(primary()).trim(),primary().props.variant,primary().props.blocked],['Konto erstellen','primary',de('rbac.blocked.loading')],'first load: "Create account" blocked until the list has loaded');
const firstLoad=tree=>harness.walk(body(tree).props.wide).find(node=>node.type===analysis.FirstLoad);
check([firstLoad(tree).props.label,typeof firstLoad(tree).props.onRetry],[de('rbac.loading'),'function'],'first load: the kit FirstLoad with its retry');
ok(!harness.walk(body(tree).props.wide).some(node=>node.type===kit.Skeleton),'no inline Skeleton');
check(body(tree).props.label,'Konten','the SettingsPage is named by the page');
tree=await mount(AccountsPage,{answer:()=>Promise.reject(new Error('down'))});
check(headers.length,1,'load error: one header call');
const failed=harness.walk(body(tree).props.wide).find(node=>node.type===kit.LoadFailed);
check(failed.props.text,de('rbac.loadFailed'),'load error without data: LoadFailed');
tree=await mount(AccountsPage,{answer:()=>Promise.reject(new ApiError('Forbidden',403))});
const unavailable=harness.walk(body(tree).props.wide).find(node=>node.type===kit.Unavailable);
check([headers.length,unavailable.props.reason,unavailable.props.children],[1,'right',de('rbac.needRole')],'403: one header and Unavailable right');
tree=await mount(AccountsPage,{viewer:{...owner,permissions:['portal.roleAssignments.manage']}});
check([headers.length,primary()],[1,undefined],'without the client right: no primary');
tree=await mount(AccountsPage,{data:{...base,canManageUsers:false}});
check(primary().props.blocked,de('rbac.blocked.right'),'the server flag false: blocked with the right reason');
// ---- Loaded: the table ----
tree=await mount(AccountsPage);
check([headers.length,primary().props.blocked],[1,undefined],'loaded: one header, the primary is free');
const accounts=table(tree);
check(accounts.props.columns.map(column=>column.label),['Konto','Status','Anmeldesicherheit','Aktionen'],'the columns');
check([accounts.props.cards,accounts.props.entranceId,accounts.props.foot,accounts.props.onOpen],[true,'rbac-accounts','4 von 4 Konten',undefined],'cards, entrance, foot; no row open');
const search=accounts.props.toolbar.props.search;
check([search.label,search.placeholder],[de('rbac.search.accounts'),de('rbac.placeholder.accounts')],'the Toolbar search');
const pill=accounts.props.columns[1].cell(users[1]);
check([pill.type,pill.props.kind,accounts.props.columns[1].cell(users[0]).props.kind,accounts.props.columns[1].cell(users[2]).props.kind],[kit.StatusPill,'waiting','success','neutral'],'status pills: Active success, Activation pending waiting, Deactivated neutral');
ok(harness.text(accounts.props.columns[2].cell(users[3])).includes('Microsoft Entra ID'),'the Entra tag');
ok(harness.text(accounts.props.columns[2].cell(users[1])).includes(de('rbac.noPassword')),'"Password not set up yet"');
ok(!harness.walk(tree).some(node=>node.type===kit.IconBtn),'no refresh IconBtn');
check(accounts.props.columns[3].className,'sdx-col-actions','the menu column');
// ---- Row menus ----
const accountEntries=name=>harness.menu(tree,'Aktionen für '+name).map(entry=>entry.separator?'---':[entry.label,entry.danger??false,entry.blocked??null]);
check(accountEntries('Ada'),[['Konto bearbeiten…',false,null],['Rolle zuweisen…',false,null],['Passwortlink erstellen…',false,null],'---',['Konto deaktivieren…',true,null]],'a local account: edit, assign, link, separator, deactivate (danger)');
check(accountEntries('Owner').at(-1),['Konto deaktivieren…',true,de('rbac.blocked.ownAccount')],'the own account cannot be deactivated');
check(accountEntries('Dora'),[['Konto bearbeiten…',false,null],['Rolle zuweisen…',false,de('rbac.blocked.assignDisabled')],['Passwortlink erstellen…',false,de('rbac.blocked.passwordLinkDisabled')],'---',['Konto aktivieren…',false,null]],'a deactivated account: assign and link blocked, "Activate account…"');
check(accountEntries('Erik Entra'),[['Rolle zuweisen…',false,null],'---',['Konto deaktivieren…',true,null]],'an Entra account: no edit and no password link');
tree=await mount(AccountsPage,{viewer:{...owner,permissions:['portal.users.manage']}});
check(accountEntries('Ada')[1],['Rolle zuweisen…',false,de('rbac.blocked.assignRight')],'without the assignment right: blocked');
tree=await mount(AccountsPage,{demo:true});
check([calls[0],accountEntries('Ada')[1]],[{url:'/api/rbac',body:undefined},['Rolle zuweisen…',false,de('rbac.blocked.assignDemo')]],'demo: the page loads and only "Assign role…" is blocked');
ok(!harness.text(tree).includes(de('rbac.demo'))&&!html().includes(de('rbac.demo')),'demo: no rbac.demo text');
check(primary().props.blocked,undefined,'demo: "Create account" is free');
// ---- Refresh: one GET, the table stays ----
tree=await mount(AccountsPage);
let pending;respond=(url,body)=>body?Promise.resolve({ok:true}):new Promise(resolve=>{pending=()=>resolve(structuredClone(base));});
refreshCount=1;tree=await flush();
check(calls.length,2,'a frame refresh sends one GET');
ok(table(tree)&&!harness.walk(body(tree).props.wide).some(node=>node.type===kit.Skeleton),'the table stays without a skeleton');
pending();await withWindow(()=>harness.settle());respond=ready();
// ---- Search and empty ----
tree=await mount(AccountsPage);table(tree).props.toolbar.props.search.onChange('zzz');tree=render();
check([table(tree).props.empty.title,table(tree).props.empty.action.type,table(tree).props.empty.action.props.label],[de('rbac.accounts.noMatch'),analysis.ResetAction,'Suche löschen'],'no match: "Clear search"');
// ---- Create: the drawer, its checks, the body and the link dialog ----
tree=await mount(AccountsPage);primary().props.onClick();tree=render();
check([drawer(tree).props.title,drawer(tree).props.description,drawer(tree).props.dirty],['Konto erstellen',de('rbac.dialog.accountHint'),false],'the create drawer');
check([harness.text(submit(tree)).trim(),submit(tree).props.blocked],['Konto erstellen',de('rbac.blocked.usernameInvalid')],'the submit is blocked while the user name is invalid');
ok(harness.walk(drawer(tree)).some(node=>node.type===kit.Notice&&node.props.children===de('rbac.accountRightsHint')),'the rights hint on create');
fieldControl(tree,'Benutzername').props.onChange({target:{value:'New.User'}});tree=render();
check([submit(tree).props.blocked,drawer(tree).props.dirty],[de('rbac.blocked.nameMissing'),true],'then the name; the drawer is dirty');
fieldControl(tree,'Anzeigename').props.onChange({target:{value:'New User'}});tree=render();
check(submit(tree).props.blocked,undefined,'a valid form');
respond=(url,body)=>body?Promise.resolve({ok:true,user:{id:'new-id'},invitationUrl:'https://sd.test/#invite=X',expiresAt:Date.now()+600000}):Promise.resolve(structuredClone(base));
harness.walk(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=render();
check([calls.length,primary().props.blocked],[1,de('fleet.menu.saving')],'the step-up waits; the primary says a change runs');
tree=await verify('create');
check(calls[1].body,{action:'create-user',username:'new.user',displayName:'New User',email:undefined,managementToken:'create'},'the create body');
ok(!drawer(tree),'the drawer closes');
let link=harness.walk(tree).find(node=>node.type===Dialog&&node.props.open);
check([link.props.title,link.props.description],[de('rbac.link.title'),de('rbac.link.description',{label:'new.user'})],'the link Dialog');
const copy=harness.walk(link).find(node=>node.type===kit.CopyValue);
check([copy.props.value,copy.props.label,copy.props.success],['https://sd.test/#invite=X',de('rbac.link.copy'),de('rbac.link.copied')],'CopyValue of the link');
check(harness.text(link.props.footer).trim(),de('common.close'),'one button, Close');
check(harness.toastCalls.length,0,'no toast before the link closes');
link.props.footer.props.onClick();tree=render();
ok(!harness.walk(tree).some(node=>node.type===Dialog&&node.props.open),'the link dialog closes');
const created=harness.toastCalls.at(-1);
check([created.text,created.options.duration,created.options.action.label],[de('rbac.toast.userCreated'),10000,'Rolle zuweisen'],'the created toast with "Assign role" for 10 s');
created.options.action.onClick();check(assigned.at(-1),'new-id','the toast action hands the new account on');
// ---- Edit: read-only user name, no changes, a success toast, an error keeps the drawer ----
tree=await mount(AccountsPage);harness.menu(tree,'Aktionen für Ada').find(entry=>entry.id==='edit').onSelect();tree=render();
check([drawer(tree).props.title,harness.text(submit(tree)).trim(),submit(tree).props.blocked],['Konto bearbeiten','Speichern',de('common.noChanges')],'the edit drawer: "Save" blocked without a change');
ok(harness.walk(drawer(tree)).some(node=>node.type===kit.Facts&&node.props.items[0].value==='ada'),'the user name is read-only');
fieldControl(tree,'Anzeigename').props.onChange({target:{value:'Ada L.'}});tree=render();
respond=(url,body)=>body?Promise.reject(new Error('Ungültig')):Promise.resolve(structuredClone(base));
harness.walk(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await verify('edit');
check([harness.toasts.at(-1),!!drawer(tree),fieldControl(tree,'Anzeigename').props.value],['error:Ungültig',true,'Ada L.'],'a failure: error toast, the drawer keeps its input');
respond=ready();harness.walk(render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await verify('edit');
check([calls.at(-2).body,harness.toasts.at(-1),!!drawer(tree)],[{action:'update-user',userId:'ada',displayName:'Ada L.',email:'',managementToken:'edit'},de('rbac.toast.userSaved'),false],'success: the body of today, the toast, the drawer closes');
// ---- Confirmations ----
const confirmOf=async(name,id)=>{tree=await mount(AccountsPage);harness.menu(tree,'Aktionen für '+name).find(entry=>entry.id===id).onSelect();return openConfirm(render());};
let dialog=await confirmOf('Ada','disable');
check([dialog.props.title,dialog.props.confirmLabel,dialog.props.tone,dialog.props.lines],[de('rbac.disableAccount.title'),'Konto deaktivieren','danger',[{label:'Konto',value:'Ada'}]],'deactivate: danger with its verb');
dialog=await confirmOf('Dora','enable');
check([dialog.props.confirmLabel,dialog.props.tone],['Konto aktivieren','default'],'activate: default');
dialog=await confirmOf('Ada','link');
check([dialog.props.title,dialog.props.confirmLabel,dialog.props.tone],['Neuen Passwortlink erstellen?','Passwortlink erstellen','default'],'password link: default');
respond=(url,body)=>body?Promise.resolve({ok:true,invitationUrl:'https://sd.test/#reset',expiresAt:Date.now()+600000}):Promise.resolve(structuredClone(base));
dialog.props.onConfirm();tree=await verify('link');
check(calls[1].body,{action:'reset-link',userId:'ada',managementToken:'link'},'the reset-link body');
link=harness.walk(tree).find(node=>node.type===Dialog&&node.props.open);ok(link,'the link dialog opens after "Create password link"');
link.props.footer.props.onClick();check(harness.toastCalls.filter(call=>call.text===de('rbac.toast.userCreated')).length,0,'closing a reset link offers no "Assign role"');
ok(harness.toasts.includes(de('rbac.passwordLink.created')),'the password link toast');

// ======== User groups ========
tree=await mount(UserGroupsPage);
check([headers.length,harness.text(primary()).trim(),primary().props.variant],[1,'Benutzergruppe erstellen','primary'],'the header with "Create user group"');
const groupTable=table(tree);
check(groupTable.props.columns.map(column=>column.label),['Benutzergruppe','Mitglieder','Status','Aktionen'],'the columns');
check([groupTable.props.cards,groupTable.props.entranceId,groupTable.props.foot,groupTable.props.openLabel(groups[0])],[true,'rbac-groups','2 von 2 Benutzergruppen','Benutzergruppe Operations öffnen'],'cards, entrance, foot and the open label');
check([groupTable.props.columns[1].cell(groups[0]),groupTable.props.columns[2].cell(groups[1]).props.kind],['1 Mitglied','neutral'],'members and status');
const groupEntries=name=>harness.menu(tree,'Aktionen für '+name).map(entry=>entry.separator?'---':[entry.label,entry.danger??false]);
check(groupEntries('Operations'),[['Benutzergruppe bearbeiten…',false],['Benutzergruppe deaktivieren…',false],'---',['Benutzergruppe löschen…',true]],'the group menu');
check(groupEntries('Altgruppe')[1],['Benutzergruppe aktivieren…',false],'"Activate user group…" for a deactivated group');
const groupConfirm=async(name,id)=>{tree=await mount(UserGroupsPage);harness.menu(tree,'Aktionen für '+name).find(entry=>entry.id===id).onSelect();return openConfirm(render());};
dialog=await groupConfirm('Operations','disable');check([dialog.props.confirmLabel,dialog.props.tone,dialog.props.lines],['Benutzergruppe deaktivieren','danger',[{label:'Benutzergruppe',value:'Operations'}]],'deactivate group: danger');
dialog=await groupConfirm('Altgruppe','enable');check([dialog.props.confirmLabel,dialog.props.tone],['Benutzergruppe aktivieren','default'],'activate group: default');
dialog=await groupConfirm('Operations','delete');check([dialog.props.confirmLabel,dialog.props.tone],['Benutzergruppe löschen','danger'],'delete group: danger');
dialog.props.onConfirm();tree=await verify('delete');check([calls[1].body,harness.toasts.at(-1)],[{action:'delete-group',id:'ops',managementToken:'delete'},de('rbac.toast.groupDeleted')],'the delete body and toast');
// ---- No groups: Empty with the next action ----
tree=await mount(UserGroupsPage,{data:{...base,userGroups:[]}});
const none=table(tree).props.empty;
check([none.icon===undefined,none.title,none.children,none.action.props.variant,harness.text(none.action).trim()],[false,de('rbac.groups.none'),de('rbac.groups.noneHint'),'secondary','Benutzergruppe erstellen'],'no groups: the Empty with "Create user group" as a secondary action');
// ---- The group drawer ----
tree=await mount(UserGroupsPage);table(tree).props.onOpen(groups[0]);tree=render();
check([drawer(tree).props.title,drawer(tree).props.description],['Operations',de('rbac.group.rightsHint')],'the group drawer head');
const members=harness.table(drawer(tree),de('rbac.group.membersTitle'));
check([members.props.variant,members.props.rows.map(row=>row.id)],['flush',['owner']],'the members table');
const memberMenu=harness.menu(drawer(tree),'Aktionen für Owner');
check(memberMenu.map(entry=>[entry.label,entry.danger]),[['Mitglied entfernen…',true]],'the member row menu');
const pick=harness.walk(drawer(tree)).find(node=>node.type===kit.PickList);
check([pick.props.mode,pick.props.label],['radio',de('rbac.group.pickLabel')],'the pick list');
check(harness.walk(pick).filter(node=>node.type===kit.PickRow).map(node=>node.props.label),['Ada · ada','Erik Entra · erik@contoso.example'],'active and invited accounts that are not members');
const addButton=()=>harness.walk(drawer(render())).find(node=>node.type===kit.Btn&&harness.text(node).trim()==='Mitglied hinzufügen');
check([addButton().props.variant,addButton().props.blocked],[undefined,de('rbac.group.chooseAccount')],'"Add member" is secondary and blocked until an account is picked');
harness.walk(pick).find(node=>node.type===kit.PickRow&&node.props.label==='Ada · ada').props.onSelect();
check(addButton().props.blocked,undefined,'picked');
addButton().props.onClick();tree=await verify('member');
check([calls[1].body,!!drawer(tree)],[{action:'add-member',groupId:'ops',userId:'ada',managementToken:'member'},true],'the add-member body; the drawer stays open');
memberMenu[0].onSelect();dialog=openConfirm(render());
check([dialog.props.confirmLabel,dialog.props.tone,dialog.props.lines.map(line=>line.label)],['Mitglied entfernen','danger',['Konto','Benutzergruppe']],'remove member: danger with account and group');
tree=await mount(UserGroupsPage,{data:{...base,userGroups:[{...groups[0],userIds:[]}]}});table(tree).props.onOpen(groups[0]);tree=render();
check(harness.table(drawer(tree),de('rbac.group.membersTitle')).props.empty.title,de('rbac.group.noMembers'),'no members');
// ---- Create and edit ----
tree=await mount(UserGroupsPage);primary().props.onClick();tree=render();
check([drawer(tree).props.title,harness.text(submit(tree)).trim(),submit(tree).props.blocked],['Benutzergruppe erstellen','Benutzergruppe erstellen',de('rbac.blocked.nameMissing')],'the create drawer');
fieldControl(tree,'Name').props.onChange({target:{value:'Neu'}});tree=render();
check([drawer(tree).props.dirty,submit(tree).props.blocked],[true,undefined],'dirty and valid');
harness.walk(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await verify('group');
check([calls[1].body,harness.toasts.at(-1)],[{action:'create-group',name:'Neu',description:'',managementToken:'group'},de('rbac.toast.groupCreated')],'the create body and toast');
tree=await mount(UserGroupsPage);harness.menu(tree,'Aktionen für Operations').find(entry=>entry.id==='edit').onSelect();tree=render();
check([drawer(tree).props.title,harness.text(submit(tree)).trim(),submit(tree).props.blocked],['Benutzergruppe bearbeiten','Speichern',de('common.noChanges')],'the edit drawer');

// ======== Roles ========
tree=await mount(RolesPage);
check([headers.length,harness.text(primary()).trim()],[1,'Rolle erstellen'],'the header with "Create role"');
const roleTable=table(tree);
check(roleTable.props.columns.map(column=>column.label),['Rolle','Typ','Berechtigungen','Aktionen'],'the columns (no owner before the separation)');
check([roleTable.props.foot,roleTable.props.columns[1].cell(roles[0]),roleTable.props.columns[2].cell(roles[1])],['3 von 3 Rollen',de('rbac.role.builtIn'),de('rbac.role.rightCount',{count:3})],'foot, type and permission count');
check(roleTable.props.columns[3].cell(roles[0]),null,'a built-in role has no menu');
check(harness.menu(tree,'Aktionen für Helpdesk').map(entry=>entry.separator?'---':[entry.label,entry.danger??false,entry.blocked??null]),[['Rolle bearbeiten…',false,null],'---',['Rolle löschen…',true,null]],'a custom role: edit, separator, delete (danger)');
check(harness.menu(tree,'Aktionen für Zugewiesen').at(-1).blocked,de('rbac.role.removeAssignmentsFirst'),'an assigned role cannot be deleted');
harness.menu(tree,'Aktionen für Helpdesk').at(-1).onSelect();dialog=openConfirm(render());
check([dialog.props.confirmLabel,dialog.props.tone,dialog.props.lines],['Rolle löschen','danger',[{label:'Rolle',value:'Helpdesk'}]],'delete role: danger');
// ---- The read-only drawer of a built-in role ----
tree=await mount(RolesPage);table(tree).props.onOpen(roles[0]);tree=render();
check([drawer(tree).props.title,drawer(tree).props.wide,harness.text(drawer(tree).props.footer).trim()],['Reader',true,''],'a built-in role opens read-only and wide');
check(drawer(tree).props.footer.props.label,de('common.close'),'its footer is Close');
ok(harness.walk(drawer(tree)).some(node=>node.type===kit.Notice&&node.props.children===de('rbac.role.readOnly')),'the read-only notice');
check(harness.walk(drawer(tree)).filter(node=>node.type===kit.Facts).flatMap(node=>node.props.items.map(item=>[item.label,item.value,item.mono])),[[de('permission.view'),'view',true]],'the permission with its id in mono');
ok(!harness.walk(drawer(tree)).some(node=>node.type==='form'),'no form');
// ---- The editor of a custom role: German names from the catalog, an unknown id as itself ----
tree=await mount(RolesPage);table(tree).props.onOpen(roles[1]);tree=render();
check([drawer(tree).props.title,harness.text(submit(tree)).trim(),submit(tree).props.blocked],['Rolle bearbeiten','Speichern',de('common.noChanges')],'a custom role opens the editor');
const rows=()=>harness.walk(drawer(render())).filter(node=>node.type===kit.PickCheckRow);
check(rows().map(node=>[node.props.label,node.props.hint,node.props.checked]),[[de('permission.portal.users.manage'),'portal.users.manage',false],[de('permission.view'),'view',true],[de('permission.alerts.manage'),'alerts.manage',true],[de('permission.terminal'),'terminal',false]],'the checkbox rows show the catalog names and ids, by group');
ok(harness.walk(drawer(render())).filter(node=>node.type==='fieldset').length>=2,'one fieldset per permission group');
tree=await mount(RolesPage);table(tree).props.onOpen(roles[2]);tree=render();
ok(rows().length>0,'an assigned role keeps its checkboxes with the assignment right');
tree=await mount(RolesPage,{data:{...base,canManageAssignments:false}});harness.menu(tree,'Aktionen für Zugewiesen')[0].onSelect();tree=render();
ok(rows().length===0&&harness.walk(drawer(tree)).some(node=>node.type===kit.Notice&&node.props.children===de('rbac.role.assignedHint')),'an assigned role without the assignment right: the hint and no checkboxes');
tree=await mount(RolesPage,{viewer:{...owner,permissions:[]},data:{...base,canManageRoles:false}});table(tree).props.onOpen({...roles[1]});tree=render();
check(harness.walk(drawer(tree)).filter(node=>node.type===kit.Facts).flatMap(node=>node.props.items.map(item=>item.label)),[de('permission.view'),de('permission.alerts.manage'),'legacy.right'],'read-only for a viewer without the right; an unknown id shows as itself');
// ---- Create role ----
tree=await mount(RolesPage);primary().props.onClick();tree=render();
check([drawer(tree).props.title,harness.text(submit(tree)).trim(),submit(tree).props.blocked],['Rolle erstellen','Rolle erstellen',de('rbac.blocked.nameMissing')],'the create drawer');
fieldControl(tree,'Name').props.onChange({target:{value:'Neu'}});
check(submit(render()).props.blocked,de('rbac.blocked.noPermission'),'blocked without a permission');
rows().find(node=>node.props.hint==='view').props.onChange(true);
check(submit(render()).props.blocked,undefined,'valid');
harness.walk(render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await verify('role');
check([calls[1].body,harness.toasts.at(-1)],[{action:'create-role',name:'Neu',description:'',permissions:['view'],managementToken:'role'},de('rbac.toast.roleCreated')],'the create body and toast');
await withWindow(()=>harness.reset());

// ======== Copy, icons, count columns, the role description, the body states and the shared confirm ========
// ---- "Add member" without a pick names the next step as a full sentence ----
ok(de('rbac.group.chooseAccount').endsWith('.')&&de('rbac.group.chooseAccount')!=='Konto auswählen','rbac.group.chooseAccount is a full sentence with a period');
tree=await mount(UserGroupsPage);table(tree).props.onOpen(groups[0]);tree=render();
check(harness.walk(drawer(tree)).find(node=>node.type===kit.Btn&&harness.text(node).trim()==='Mitglied hinzufügen').props.blocked,de('rbac.group.chooseAccount'),'"Add member" without a pick is blocked with the sentence');
// ---- "Create user group" uses Users; "Create account" and "Add member" keep UserPlus ----
tree=await mount(UserGroupsPage);
check(primary().props.icon.displayName,'Users','"Create user group" in the header uses Users');
tree=await mount(UserGroupsPage,{data:{...base,userGroups:[]}});
check(table(tree).props.empty.action.props.icon.displayName,'Users','"Create user group" in the Empty uses Users');
tree=await mount(AccountsPage);check(primary().props.icon.displayName,'UserPlus','"Create account" keeps UserPlus');
tree=await mount(UserGroupsPage);table(tree).props.onOpen(groups[0]);tree=render();
check(harness.walk(drawer(tree)).find(node=>node.type===kit.Btn&&harness.text(node).trim()==='Mitglied hinzufügen').props.icon.displayName,'UserPlus','"Add member" keeps UserPlus');
// ---- tabular figures in the count columns, nowhere else ----
tree=await mount(UserGroupsPage);
check(table(tree).props.columns.map(column=>[column.id,column.tabular??false]),[['group',false],['members',true],['status',false],['actions',false]],'User groups: only Members is tabular');
check(table(tree).props.columns[1].cell(groups[0]),'1 Mitglied','the Members text is unchanged');
tree=await mount(RolesPage);
check(table(tree).props.columns.map(column=>[column.id,column.tabular??false]),[['role',false],['type',false],['permissions',true],['actions',false]],'Roles: only Permissions is tabular');
check(table(tree).props.columns[2].cell({...roles[0],permissions:['*']}),de('rbac.role.allRights'),'the Permissions text is unchanged');
// ---- the role description is a textarea with the group's limit ----
tree=await mount(RolesPage);primary().props.onClick();tree=render();
let description=fieldControl(tree,de('common.description'));
check([description.type,description.props.maxLength],['textarea',500],'create role: the description is a textarea with maxLength 500');
description.props.onChange({target:{value:'Kurz'}});fieldControl(render(),de('common.name')).props.onChange({target:{value:'Neu'}});
rows().find(node=>node.props.hint==='view').props.onChange(true);
harness.walk(render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await verify('described');
check(calls[1].body,{action:'create-role',name:'Neu',description:'Kurz',permissions:['view'],managementToken:'described'},'the request body is unchanged');
tree=await mount(RolesPage);table(tree).props.onOpen(roles[1]);tree=render();
description=fieldControl(tree,de('common.description'));
check([description.type,drawer(tree).props.dirty],['textarea',false],'edit role: a textarea, clean until a change');
description.props.onChange({target:{value:'Neu beschrieben'}});
check([drawer(render()).props.dirty,submit(render()).props.blocked],[true,undefined],'a description change makes it dirty and saveable');
// ---- one state ladder on each page ----
for(const [Page,name] of [[AccountsPage,'Accounts'],[UserGroupsPage,'User groups'],[RolesPage,'Roles']]){
 tree=await mount(Page,{answer:()=>new Promise(()=>{})});
 check(firstLoad(tree)?.props.label,de('rbac.loading'),name+': first load is FirstLoad');
 tree=await mount(Page,{answer:()=>Promise.reject(new Error('down'))});
 check(harness.walk(body(tree).props.wide).filter(node=>node.type===kit.LoadFailed).map(node=>node.props.text),[de('rbac.loadFailed')],name+': a load error without data is LoadFailed');
 tree=await mount(Page,{answer:()=>Promise.reject(new ApiError('Forbidden',403))});
 check(harness.walk(body(tree).props.wide).filter(node=>node.type===kit.Unavailable).map(node=>[node.props.reason,node.props.children]),[['right',de('rbac.needRole')]],name+': 403 is Unavailable');
 tree=await mount(Page);respond=()=>Promise.reject(new Error('down'));refreshCount=1;tree=await flush();
 const stale=harness.walk(body(tree).props.wide);
 ok(stale.some(node=>node.type===kit.LoadFailed&&node.props.text===de('rbac.loadFailed'))&&table(tree),name+': a failed reload keeps the table below LoadFailed');
 respond=ready();
}
// ---- every confirmation through useRbacConfirm ----
const confirmRun=async({Page,owner:menuName,id,token,openDrawer,data,answer})=>{
 tree=await mount(Page,{data,answer});
 if(openDrawer){table(tree).props.onOpen(openDrawer);tree=render();}
 harness.menu(tree,'Aktionen für '+menuName).find(entry=>entry.id===id).onSelect();
 const dialog=openConfirm(render());
 dialog.props.onConfirm();dialog.props.onConfirm();
 const hidden=!openConfirm(render())&&harness.walk(render()).find(node=>node.type===MfaStepUp).props.open===true;
 tree=await verify(token);
 return {dialog:[dialog.props.title,dialog.props.confirmLabel,dialog.props.tone,dialog.props.lines.length>0,dialog.props.busy],hidden,changes:calls.filter(call=>call.body).length,closed:!openConfirm(tree)};
};
for(const [label,run,title] of [
 ['deactivate account',{Page:AccountsPage,owner:'Ada',id:'disable',token:'c1'},de('rbac.disableAccount.title')],
 ['activate account',{Page:AccountsPage,owner:'Dora',id:'enable',token:'c2'},de('rbac.enableAccount.title')],
 ['password link',{Page:AccountsPage,owner:'Ada',id:'link',token:'c3'},de('rbac.passwordLink.title')],
 ['deactivate group',{Page:UserGroupsPage,owner:'Operations',id:'disable',token:'c4'},de('rbac.group.disable.title')],
 ['delete group',{Page:UserGroupsPage,owner:'Operations',id:'delete',token:'c5'},de('rbac.group.delete.title')],
 ['remove member',{Page:UserGroupsPage,owner:'Owner',id:'remove',token:'c6',openDrawer:groups[0]},de('rbac.member.remove.title')],
 ['delete role',{Page:RolesPage,owner:'Helpdesk',id:'delete',token:'c7'},de('rbac.role.delete.title')],
]){
 const result=await confirmRun(run);
 check([result.dialog[0],result.dialog[3],result.dialog[4]],[title,true,false],label+': the confirmation opens with its title and lines');
 check([result.hidden,result.changes,result.closed],[true,1,true],label+': hidden while the step-up dialog is open, one change sent, closed after it');
}
check(!!harness.walk(tree).find(node=>node.type===Dialog&&node.props.open),false,'delete role opens no link dialog');
await confirmRun({Page:AccountsPage,owner:'Ada',id:'link',token:'link-again',answer:(url,body)=>body?Promise.resolve({ok:true,invitationUrl:'https://sd.test/#again',expiresAt:Date.now()+600000}):Promise.resolve(structuredClone(base))});
ok(harness.walk(render()).find(node=>node.type===Dialog&&node.props.open),'"Create password link" still opens the link dialog with the reply');
await withWindow(()=>harness.reset());
// ---- the shared guards in the source ----
{
 const views=['ui/settings/settings-accounts.tsx','ui/settings/settings-user-groups.tsx','ui/settings/settings-roles.tsx','ui/devices/configuration/permissions-tab.tsx'];
 for(const file of views){
  const source=fs.readFileSync(file,'utf8');
  check([source.includes('?.generation===generation?'),source.includes('generation===rbac.generation'),source.includes('confirmNow'),source.includes('!rbac.dialog.open'),/useRbacConfirm[<(]/.test(source),/rbacBody\(/.test(source),/<Skeleton\b/.test(source)],[false,false,false,false,true,true,false],file+': useRbacConfirm, useGenerationState and rbacBody, no own generation filter, confirmNow or confirm wiring');
 }
 const permissions=fs.readFileSync('ui/devices/configuration/permissions-tab.tsx','utf8'),ladder=fs.readFileSync('ui/settings/rbac-body.tsx','utf8');
 ok(!/LoadFailed[^;]*from '@\/ui\/kit\/analysis-tab'/.test(permissions)&&!/LoadFailed[^;]*from '@\/ui\/kit\/analysis-tab'/.test(ladder),'LoadFailed never comes from the analysis-tab re-export');
 ok(/import \{[^}]*\bLoadFailed\b[^}]*\} from '@\/ui\/kit\/kit'/.test(ladder)&&/import \{[^}]*\bFirstLoad\b[^}]*\} from '@\/ui\/kit\/analysis-tab'/.test(ladder),'the ladder takes LoadFailed from the kit source and FirstLoad from analysis-tab');
}

// ======== The old panel is gone: one file per page, the Permissions view, the hook and the model ========
{
 const oldName='rbac'+'-panel';
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>{const full=path.join(dir,item.name);return item.isDirectory()?item.name==='node_modules'?[]:walk(full):[full];});
 check(['app','ui','lib','tests','docs'].flatMap(walk).filter(file=>fs.readFileSync(file,'utf8').includes(oldName)),[],'no file in app/, lib/, tests/ or docs/ names the old panel');
 for(const file of ['ui/settings/settings-accounts.tsx','ui/settings/settings-user-groups.tsx','ui/settings/settings-roles.tsx','ui/devices/configuration/permissions-tab.tsx','ui/settings/rbac-data.ts','ui/settings/rbac-model.ts']){
  const source=fs.readFileSync(file,'utf8');
  check([/components\/ui\/|ErrorNote|loading-skeleton|detail-drawer|sd-access-loading|sdx?-skeleton-bar|<table|<select|<input type="checkbox"/.test(source),/disabled=\{[^}]*\}[^>]*title=|title=[^>]*disabled=\{/.test(source),/common\.confirm'/.test(source)],[false,false,false],file+': kit only, no native disabled with a title, no common.confirm');
 }
}
console.log(`PASS settings rbac pages (${checks} checks): Accounts, User groups and Roles render the frame header with their primary and blocked reasons in every state, one SettingsPage with the shared ladder (FirstLoad, LoadFailed, Unavailable, stale data), the copy and controls (Add member sentence, Users icon, tabular counts, role description textarea, useRbacConfirm on every confirmation), demo without blocks but "Assign role…", the frame refresh without a skeleton, kit tables with cards, foot and empty states, row menus with their order, danger entries and reasons, the drawers with their checks and bodies, the confirmations with their verbs and tones, the toasts, the link Dialog and the "Assign role" toast action.`);
