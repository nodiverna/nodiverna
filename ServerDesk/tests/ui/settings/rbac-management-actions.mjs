// Drive the real access management pages (ui/settings/settings-accounts.tsx, settings-user-groups.tsx, settings-roles.tsx) and the
// Permissions view (ui/devices/configuration/permissions-tab.tsx) on the shared hook (ui/settings/rbac-data.ts) and the real step-up flow
// (useStepUp, ui/session/step-up-retry.ts) across fresh-proof, actor and scope boundaries, and the shared guards of the hook file on their
// own: useGenerationState (null after a viewer change, a scope change and the session lock) and useRbacConfirm (one change, no
// second confirm or close while busy, closed after the change and on a generation change).
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map();
let active=null,index=0,calls=[],replies=[],refreshes=0;const toasts=[];
const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((item,i)=>Object.is(item,b[i]));
const react={...React,useState(initial){const i=index++,owner=active;if(!owner.hooks[i])owner.hooks[i]={value:typeof initial==='function'?initial():initial};const slot=owner.hooks[i];return [slot.value,next=>{const value=typeof next==='function'?next(slot.value):next;if(!Object.is(slot.value,value)){slot.value=value;owner.dirty=true;}}];},useRef(initial){const i=index++;if(!active.hooks[i])active.hooks[i]={current:initial};return active.hooks[i];},useMemo(fn,deps){const i=index++,previous=active.hooks[i];if(previous&&same(previous.deps,deps))return previous.value;const value=fn();active.hooks[i]={value,deps};return value;},useCallback(fn,deps){return react.useMemo(()=>fn,deps);},useEffect(fn,deps){const i=index++,previous=active.hooks[i];if(previous&&same(previous.deps,deps))return;active.hooks[i]={deps,cleanup:previous?.cleanup};active.effects.push({i,fn});},useId(){return 'id'+index++;}};
function StepUp(){return null;}
class ApiError extends Error{constructor(status,code=''){super(code||'refused '+status);this.status=status;this.code=code;}}
const toast={success:(text,options)=>toasts.push({text,options}),error:text=>toasts.push({text:'error:'+text}),info:text=>toasts.push({text:'info:'+text})};
const api=async(url,body,signal)=>{calls.push({url,body,signal});const reply=replies.shift();if(reply===undefined)throw new Error('Unexpected API request '+url);if(reply instanceof Error)throw reply;if(reply?.promise)return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal?.addEventListener('abort',abort,{once:true});reply.promise.then(value=>{signal?.removeEventListener('abort',abort);resolve(value);},reject);});return reply;};
function load(filename){const absolute=path.resolve(filename);if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};const mod={exports:{}};cache.set(absolute,mod);const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;function localRequire(id){const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;if(id==='react')return react;if(id==='sonner')return {toast};if(id==='@/ui/base/api')return {api,ApiError,message:error=>error instanceof Error?error.message:'Error'};if(id==='@/ui/session/mfa-step-up')return {MfaStepUp:StepUp};if(id==='@/ui/base/http')return {SESSION_LOCK_EVENT:'test:lock'};if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx',base+'.js'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());if(file)return load(file);}return require(id);}new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;}
class Harness{constructor(component,props){this.component=component;this.props=props;this.hooks=[];this.effects=[];this.dirty=true;this.render();}render(){active=this;index=0;this.effects=[];this.dirty=false;this.tree=this.component(this.props);for(const effect of this.effects){const slot=this.hooks[effect.i];slot.cleanup?.();slot.cleanup=effect.fn();}active=null;}async settle(){for(let turn=0;turn<4;turn++){for(let i=0;i<40;i++){await Promise.resolve();if(this.dirty)this.render();}await new Promise(resolve=>setTimeout(resolve,0));}}dispose(){for(const slot of this.hooks)slot?.cleanup?.();}}
// Walks children and the element props of the kit parts (primary, actions, footer, toolbar, the SettingsPage wide part, an Empty action) and the cells of every DataTable row.
const elementProps=['primary','actions','footer','action','toolbar','wide'];
function find(node,predicate){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const child of node){const result=find(child,predicate);if(result)return result;}return null;}if(predicate(node))return node;
 for(const key of elementProps){const result=find(node.props?.[key],predicate);if(result)return result;}
 if(node.props?.empty?.action){const result=find(node.props.empty.action,predicate);if(result)return result;}
 if(Array.isArray(node.props?.columns)&&Array.isArray(node.props?.rows))for(const row of node.props.rows)for(const column of node.props.columns){const result=find(column.cell(row),predicate);if(result)return result;}
 return find(node.props?.children,predicate);}
function text(node){if(node==null||typeof node==='boolean')return '';if(typeof node!=='object')return String(node);return Array.isArray(node)?node.map(text).join(''):text(node.props?.children);}
// A control by its name: aria-label, or the label of the kit Field around it.
const named=(h,label)=>find(h.tree,node=>node.props?.['aria-label']===label)??find(h.tree,node=>node.props?.label===label&&React.isValidElement(node.props?.children))?.props.children??null;
function byLabel(h,label){const result=named(h,label);assert.ok(result,label);return result;}
function button(h,label){const result=find(h.tree,node=>(typeof node.props?.onClick==='function'||node.props?.type==='submit')&&text(node)===label);assert.ok(result,label);return result;}
const menu=(h,label)=>find(h.tree,node=>Array.isArray(node.props?.entries)&&node.props.label===label)?.props.entries??null;
const entry=(h,label,id)=>{const entries=menu(h,label);assert.ok(entries,label);return entries.find(item=>item.id===id);};
const step=h=>find(h.tree,node=>node.type===StepUp);
const submitForm=h=>find(h.tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});
function deferred(){let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};}
const view={id:'owner-id',userId:'owner-id',label:'Owner',username:'owner',permissions:['*'],canManageDeviceGroups:true};
const data={users:[{id:'owner-id',username:'owner',displayName:'Owner',email:null,status:'active',mfaEnabled:true,passwordSet:true},{id:'reader-id',username:'reader',displayName:'Reader',email:null,status:'active',mfaEnabled:true,passwordSet:true}],userGroups:[{id:'group-id',name:'Operations',description:'',enabled:true,userIds:[]}],roles:[{id:'builtin-owner',name:'Owner',description:'All rights',permissions:['*'],builtIn:true},{id:'reader-role',name:'Reader',description:'Read devices',permissions:['view'],builtIn:true},{id:'uaa-role',name:'User Access Administrator',description:'Manage users',permissions:['portal.users.manage'],builtIn:true}],assignments:[],deviceGroups:[{id:'devices-id',name:'Production'}],devices:[{id:'server-id',name:'Server'}],permissions:[{id:'view',labelKey:'permission.view'},{id:'portal.users.manage',labelKey:'permission.portal.users.manage'}],canManage:true,canManageUsers:true,canManageRoles:true,canManageAssignments:true,canManageUserGroups:true};
const pages={accounts:load('ui/settings/settings-accounts.tsx').default,usergroups:load('ui/settings/settings-user-groups.tsx').default,roles:load('ui/settings/settings-roles.tsx').default};
const {ScopedPermissionEditor}=load('ui/devices/configuration/permissions-tab.tsx'),{PickCheckRow}=load('ui/kit/kit.tsx'),capabilities=load('ui/base/access-capabilities.ts');
// The console frame: the header element carries the page primary, so the walk finds it.
const frame={header:primary=>React.createElement('header',{primary}),refresh:0,tab:'',onTab(){}};
globalThis.window=new EventTarget();
const harnesses=[];
async function mount(section='accounts',viewer=view,fixture=data,scope){
 calls=[];replies=[fixture];refreshes=0;toasts.length=0;
 const common={viewer,demo:false,onRefresh:()=>refreshes++};
 const h=section==='assignments'?new Harness(ScopedPermissionEditor,{...common,scope,scopeName:scope?.type==='global'?'Alle Geräte':scope?.type==='group'?'Production':'Server'}):new Harness(pages[section],{...common,frame,onAssignRole:userId=>assigned.push(userId)});
 harnesses.push(h);await h.settle();
 if(section!=='assignments'||scope?.type==='global'||scope?.id){assert.equal(calls.length,1);assert.equal(calls[0].body,undefined);}
 return h;
}
const assigned=[];
async function create(h){button(h,'Konto erstellen').props.onClick();await h.settle();byLabel(h,'Benutzername').props.onChange({target:{value:'new-user'}});byLabel(h,'Anzeigename').props.onChange({target:{value:'New User'}});await h.settle();submitForm(h);await h.settle();assert.equal(step(h).props.open,true);assert.equal(calls.length,1,'opening privileged mutation never sends it before fresh proof');}
const linkValue=h=>find(h.tree,node=>node.props?.label==='Aktivierungslink kopieren')?.props.value;
function disposeAll(){for(const h of harnesses.splice(0))h.dispose();}
try{
 // Create: the step-up first, then the body of today, the one-time link in the kit Dialog, the toast with "Assign role" after it closes.
 let h=await mount();await create(h);replies.push({ok:true,user:{id:'new-id'},invitationUrl:'https://serverdesk.test/#invite=SECRET',expiresAt:Date.now()+600000},data);step(h).props.onVerified({managementToken:'fresh-proof'});await h.settle();
 assert.equal(calls[1].url,'/api/auth');assert.deepEqual(calls[1].body,{action:'create-user',username:'new-user',displayName:'New User',email:undefined,managementToken:'fresh-proof'});assert.equal(calls[2].body,undefined,'the data reloads');assert.equal(refreshes,1);
 assert.equal(linkValue(h),'https://serverdesk.test/#invite=SECRET','the link shows in CopyValue');assert.equal(find(h.tree,node=>node.type==='form'),null,'the drawer closes');
 assert.equal(toasts.length,0,'the created toast waits until the link dialog closes');
 button(h,'Schließen').props.onClick();await h.settle();
 assert.equal(linkValue(h),undefined,'the link dialog closes');
 assert.equal(toasts[0].text,'Konto erstellt. Weise eine Rolle zu, damit es Berechtigungen erhält.');assert.equal(toasts[0].options.duration,10000);assert.equal(toasts[0].options.action.label,'Rolle zuweisen');
 toasts[0].options.action.onClick();assert.deepEqual(assigned,['new-id'],'the toast action hands the new account to the console');disposeAll();
 // The session lock removes the one-time secret and closes the dialog.
 h=await mount();await create(h);replies.push({ok:true,invitationUrl:'https://serverdesk.test/#invite=SECRET',expiresAt:Date.now()+600000},data);step(h).props.onVerified({managementToken:'fresh-proof'});await h.settle();assert.ok(linkValue(h));
 window.dispatchEvent(new Event('test:lock'));await h.settle();assert.equal(linkValue(h),undefined,'session lock removes the one-time secret');disposeAll();
 // Cancel sends nothing and keeps the drawer with its input; a late proof after the cancel cannot send it.
 h=await mount();await create(h);const staleStep=step(h);staleStep.props.onClose();await h.settle();
 assert.equal(calls.length,1);assert.ok(find(h.tree,node=>node.type==='form'),'the drawer stays open');assert.equal(byLabel(h,'Benutzername').props.value,'new-user','with its input');
 staleStep.props.onVerified({managementToken:'old-proof'});await h.settle();assert.equal(calls.length,1,'cancelled intent cannot be restored by a late proof');disposeAll();
 // The session lock drops a waiting proof.
 h=await mount();await create(h);const lockedStep=step(h);window.dispatchEvent(new Event('test:lock'));await h.settle();lockedStep.props.onVerified({managementToken:'old-proof'});await h.settle();assert.equal(calls.length,1,'session lock prevents a late proof from replaying the mutation');assert.equal(find(h.tree,node=>node.type==='form'),null,'the lock closes the drawer');disposeAll();
 // A viewer change drops a waiting proof and closes the drawer.
 h=await mount();await create(h);const actorStep=step(h);h.props={...h.props,viewer:{...view,id:'other-id',userId:'other-id'}};replies.push(data);h.render();await h.settle();actorStep.props.onVerified({managementToken:'old-actor-proof'});await h.settle();assert.ok(calls.every(call=>call.body===undefined),'actor changes invalidate every pending mutation');assert.equal(find(h.tree,node=>node.type==='form'),null);disposeAll();
 // A proof without a management token sends nothing and says so.
 h=await mount();await create(h);step(h).props.onVerified({});await h.settle();assert.equal(calls.length,1,'missing management token never dispatches a mutation');assert.ok(toasts.some(item=>item.text==='error:Nodiverna konnte deine Identität für diese Änderung nicht bestätigen. Versuche es erneut.'),'the missing token toasts rbac.noManagementToken');assert.ok(find(h.tree,node=>node.type==='form'),'the drawer keeps its input');disposeAll();
 // A failure toasts and keeps the drawer; a 401/403 on a change reloads the data.
 h=await mount();await create(h);replies.push(new ApiError(403,''),data);step(h).props.onVerified({managementToken:'refused'});await h.settle();
 assert.ok(toasts.some(item=>item.text==='error:refused 403'),'the failure is a toast');assert.equal(calls[2].body,undefined,'a 403 on a change reloads the data');assert.ok(find(h.tree,node=>node.type==='form'),'the drawer stays open');disposeAll();
 // The proof is consumed once; unmount (a section change) aborts the request and drops its late reply.
 h=await mount();await create(h);const mutation=deferred();replies.push(mutation);const twice=step(h);twice.props.onVerified({managementToken:'once'});twice.props.onVerified({managementToken:'twice'});await h.settle();assert.equal(calls.length,2,'fresh proof is consumed only once');h.dispose();assert.equal(calls[1].signal.aborted,true,'unmount aborts the in-flight management request');mutation.resolve({ok:true,invitationUrl:'https://serverdesk.test/#invite=LATE',expiresAt:Date.now()+600000});await h.settle();assert.equal(refreshes,0,'late mutation reply cannot refresh an unmounted account');disposeAll();
 // A late load reply of an old viewer is dropped.
 {const late=deferred();calls=[];replies=[late];refreshes=0;h=new Harness(pages.accounts,{viewer:view,demo:false,onRefresh(){},frame});harnesses.push(h);await h.settle();replies.push(data);h.props={...h.props,viewer:{...view,id:'other-id',userId:'other-id'}};h.render();await h.settle();late.resolve({...data,users:[]});await h.settle();
  assert.equal(calls[0].signal.aborted,true,'a viewer change aborts the old load');assert.equal(find(h.tree,node=>node.props?.label==='Aktionen für Reader')!==null,true,'the late reply of the old viewer is dropped');disposeAll();}

 // ---- The Permissions view: the scope is fixed by the resource; no form control can change it ----
 h=await mount('assignments',view,data,{type:'group',id:'devices-id'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();byLabel(h,'Konto').props.onChange({target:{value:'reader-id'}});byLabel(h,'Rolle').props.onChange({target:{value:'reader-role'}});await h.settle();assert.equal(find(h.tree,node=>node.props?.['aria-label']==='Geltungsbereich'),null);assert.equal(button(h,'Rolle zuweisen').props.blocked,undefined);submitForm(h);await h.settle();assert.equal(calls.length,1);replies.push({ok:true},data);step(h).props.onVerified({managementToken:'scope-proof'});await h.settle();assert.deepEqual(calls[1].body,{action:'add-assignment',subjectType:'user',subjectId:'reader-id',roleId:'reader-role',scopeType:'devicegroup',scopeId:'devices-id',managementToken:'scope-proof'});assert.ok(toasts.some(item=>item.text==='Rolle zugewiesen.'));disposeAll();
 h=await mount('assignments',view,data,{type:'device',id:'server-id'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();const options=byLabel(h,'Rolle').props.children[1];assert.equal(options.some(option=>option.props.value==='uaa-role'),false,'explicit portal roles are never offered on a device');assert.equal(options.some(option=>option.props.value==='builtin-owner'),true,'scoped Owner is supported and gives only scoped device rights in the backend');byLabel(h,'Konto').props.onChange({target:{value:'reader-id'}});byLabel(h,'Rolle').props.onChange({target:{value:'uaa-role'}});await h.settle();assert.equal(button(h,'Rolle zuweisen').props.blocked,'Wähle ein Konto oder eine Benutzergruppe und eine Rolle.','a forged portal role remains invalid');submitForm(h);await h.settle();assert.equal(step(h).props.open,false);assert.equal(calls.length,1,'forcing the invalid form cannot queue portal scope elevation');disposeAll();
 h=await mount('assignments',view,data,{type:'global'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();byLabel(h,'Konto').props.onChange({target:{value:'reader-id'}});byLabel(h,'Rolle').props.onChange({target:{value:'uaa-role'}});await h.settle();assert.equal(button(h,'Rolle zuweisen').props.blocked,undefined);submitForm(h);await h.settle();replies.push({ok:true},data);step(h).props.onVerified({managementToken:'global-proof'});await h.settle();assert.deepEqual(calls[1].body,{action:'add-assignment',subjectType:'user',subjectId:'reader-id',roleId:'uaa-role',scopeType:'global',scopeId:'*',managementToken:'global-proof'});disposeAll();
 h=await mount('assignments',view,data,{type:'device',id:'server-id'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();byLabel(h,'Typ').props.onChange({target:{value:'group'}});await h.settle();byLabel(h,'Benutzergruppe').props.onChange({target:{value:'group-id'}});byLabel(h,'Rolle').props.onChange({target:{value:'reader-role'}});await h.settle();submitForm(h);await h.settle();replies.push({ok:true},data);step(h).props.onVerified({managementToken:'device-proof'});await h.settle();assert.deepEqual(calls[1].body,{action:'add-assignment',subjectType:'group',subjectId:'group-id',roleId:'reader-role',scopeType:'device',scopeId:'server-id',managementToken:'device-proof'});disposeAll();
 const scopedData={...data,assignments:[{id:'global-grant',subjectType:'user',subjectId:'owner-id',roleId:'builtin-owner',scopeType:'global',scopeId:'*'},{id:'group-grant',subjectType:'user',subjectId:'reader-id',roleId:'reader-role',scopeType:'devicegroup',scopeId:'devices-id'},{id:'device-grant',subjectType:'group',subjectId:'group-id',roleId:'reader-role',scopeType:'device',scopeId:'server-id'},{id:'other-grant',subjectType:'user',subjectId:'owner-id',roleId:'reader-role',scopeType:'devicegroup',scopeId:'another-group'}]};
 h=await mount('assignments',view,scopedData,{type:'group',id:'devices-id'});assert.equal(menu(h,'Aktionen für Owner'),null,'parent, global and sibling assignments are not editable here');assert.equal(menu(h,'Aktionen für Operations'),null,'device assignments are not editable at the group');entry(h,'Aktionen für Reader','remove').onSelect();await h.settle();{const dialog=find(h.tree,node=>typeof node.props?.onConfirm==='function'&&node.props.open===true);assert.ok(dialog,'remove opens the kit ConfirmDialog');assert.deepEqual([dialog.props.title,dialog.props.confirmLabel,dialog.props.tone,dialog.props.lines.map(line=>line.label)],['Rollenzuweisung entfernen?','Rollenzuweisung entfernen','danger',['Konto oder Benutzergruppe','Rolle','Bereich']]);assert.equal(calls.length,1,'nothing is sent before the confirmation');dialog.props.onConfirm();}await h.settle();replies.push({ok:true},scopedData);step(h).props.onVerified({managementToken:'remove-scope'});await h.settle();assert.deepEqual(calls[1].body,{action:'delete-assignment',id:'group-grant',managementToken:'remove-scope'});disposeAll();
 // A scope change discards the captured intent.
 h=await mount('assignments',view,data,{type:'group',id:'devices-id'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();byLabel(h,'Konto').props.onChange({target:{value:'reader-id'}});byLabel(h,'Rolle').props.onChange({target:{value:'reader-role'}});await h.settle();submitForm(h);await h.settle();const groupProof=step(h);h.props={...h.props,scope:{type:'device',id:'server-id'},scopeName:'Server'};replies.push(data);h.render();await h.settle();groupProof.props.onVerified({managementToken:'old-group'});await h.settle();assert.ok(calls.every(call=>call.body===undefined),'changing resource discards captured scope intent');assert.equal(step(h).props.open,false);assert.equal(find(h.tree,node=>node.type==='form'),null,'the drawer closes');disposeAll();
 for(const scope of [{type:'group'},{type:'device',id:'gone'}]){calls=[];replies=[data];h=new Harness(ScopedPermissionEditor,{viewer:view,demo:false,onRefresh(){},scope,scopeName:'X'});harnesses.push(h);await h.settle();assert.equal(find(h.tree,node=>typeof node.props?.onClick==='function'&&text(node)==='Zuweisung hinzufügen'),null,'no mutation without a concrete existing resource');disposeAll();}

 // ---- User groups: a group with role assignments needs the assignment right for every change of its access ----
 const assignedMetadata={...data,canManageAssignments:false,userGroups:[{...data.userGroups[0],userIds:['reader-id']}],roles:[...data.roles,{id:'custom-role',name:'Custom assigned',description:'Read',permissions:['view'],builtIn:false}],assignments:[{id:'group-assignment',subjectType:'group',subjectId:'group-id',roleId:'custom-role',scopeType:'devicegroup',scopeId:'devices-id'}]};
 h=await mount('usergroups',view,assignedMetadata);
 const groupReason='Diese Gruppe hat Rollen. Um sie zu ändern, brauchst du zusätzlich die Berechtigung, Rollenzuweisungen zu verwalten.';
 assert.deepEqual(['edit','disable','delete'].map(id=>entry(h,'Aktionen für Operations',id).blocked),[undefined,groupReason,groupReason],'metadata-only group editing remains available; activation and deletion need the assignment right');
 find(h.tree,node=>Array.isArray(node.props?.columns)&&node.props.label==='Benutzergruppen').props.onOpen(assignedMetadata.userGroups[0]);await h.settle();
 assert.equal(entry(h,'Aktionen für Reader','remove').blocked,groupReason,'removing a member needs it too');assert.equal(button(h,'Mitglied hinzufügen').props.blocked,groupReason,'and adding one');disposeAll();
 // Add member: one account at a time from the pick list, the drawer stays open.
 h=await mount('usergroups');find(h.tree,node=>Array.isArray(node.props?.columns)&&node.props.label==='Benutzergruppen').props.onOpen(data.userGroups[0]);await h.settle();
 assert.equal(button(h,'Mitglied hinzufügen').props.blocked,'Wähle zuerst ein Konto in der Liste.','blocked until an account is picked');
 find(h.tree,node=>node.props?.selected===false&&node.props.label==='Reader · reader').props.onSelect();await h.settle();button(h,'Mitglied hinzufügen').props.onClick();await h.settle();
 replies.push({ok:true},{...data,userGroups:[{...data.userGroups[0],userIds:['reader-id']}]});step(h).props.onVerified({managementToken:'member'});await h.settle();
 assert.deepEqual(calls[1].body,{action:'add-member',groupId:'group-id',userId:'reader-id',managementToken:'member'});assert.ok(menu(h,'Aktionen für Reader'),'the drawer stays open with the new member list');disposeAll();
 // Roles: an assigned role keeps its permissions without the assignment right; name and description stay editable.
 h=await mount('roles',view,assignedMetadata);entry(h,'Aktionen für Custom assigned','edit').onSelect();await h.settle();
 assert.equal(find(h.tree,node=>node.type===PickCheckRow),null,'assigned-role permission edits require role assignment authority');assert.match(text(h.tree),/Diese Rolle ist bereits zugewiesen/);assert.equal(byLabel(h,'Name').props.value,'Custom assigned','metadata-only role editing remains available');disposeAll();
 const uaa={...view,permissions:['portal.users.manage','portal.roleAssignments.manage'],canManageDeviceGroups:false};assert.equal(capabilities.canManageAccounts(uaa),true);assert.equal(capabilities.canManageRbac(uaa),true);assert.equal(capabilities.canManageDeviceGroups(uaa),false,'access administrators do not implicitly manage devices');const reader={...view,permissions:[],canManageDeviceGroups:false};assert.equal(capabilities.canManageAccounts(reader),false);assert.equal(capabilities.canManageRbac(reader),false);assert.equal(capabilities.canManageDeviceGroups(reader),false);assert.equal(capabilities.canManageDeviceGroups({...reader,canManageDeviceGroups:true}),true,'scoped devicegroup delegation can open an empty group');
 h=await mount('accounts',uaa,{...data,canManageUsers:false});assert.equal(button(h,'Konto erstellen').props.blocked,'Dir fehlt die Berechtigung für diese Änderung.','the canonical API capability blocks the privileged primary with its reason');disposeAll();
 // Owners of roles. Library roles everywhere, customer roles only on targets of their customer.
 {
  const first='00000000-0000-4000-8000-000000000100',other='customer-b';
  const owners=h=>{const table=find(h.tree,node=>Array.isArray(node.props?.columns)&&node.props.label==='Rollen'),column=table.props.columns.find(item=>item.id==='owner');return column?table.props.rows.map(row=>text(column.cell(row))):[];};
  // privilegedWritable follows the viewer: these fixtures pair it with libraryWritable unless a case sets it.
  const tenant=(catalog,privilegedWritable=catalog.libraryWritable)=>({...data,catalog,privilegedWritable,roles:[...data.roles.map(role=>({...role,customerId:null,customerName:null})),{id:'role-a',name:'Rolle A',description:'',permissions:['view'],builtIn:false,customerId:first,customerName:'Standardkunde'},{id:'role-b',name:'Rolle B',description:'',permissions:['view'],builtIn:false,customerId:other,customerName:'Kunde B'},{id:'library-custom',name:'Bibliothek eigen',description:'',permissions:['view'],builtIn:false,customerId:null,customerName:null}],deviceGroups:[{id:'devices-id',name:'Production',customerId:first},{id:'b-group',name:'Gruppe B',customerId:other}],devices:[{id:'server-id',name:'Server',customerId:first}],permissions:[...data.permissions,{id:'portal.roles.manage',labelKey:'permission.portal.roles.manage'}],canManageRoles:true,canManageAssignments:true});
  const community={separated:false,libraryWritable:true,customers:[{id:first,name:'Standardkunde'}]},technician={separated:true,libraryWritable:false,customers:[{id:first,name:'Standardkunde'},{id:other,name:'Kunde B'}]};
  const roleOptions=h=>byLabel(h,'Rolle').props.children[1].map(option=>option.props.value);
  const firstRight=h=>find(h.tree,node=>node.type===PickCheckRow);
  // With only the default customer: no label, no owner field, no customerId.
  let h=await mount('roles',view,tenant(community));assert.deepEqual(owners(h),[],'community: no owner labels');
  button(h,'Rolle erstellen').props.onClick();await h.settle();assert.equal(named(h,'Gehört zu'),null,'community: no owner field');
  byLabel(h,'Name').props.onChange({target:{value:'Neu'}});await h.settle();firstRight(h).props.onChange(true);await h.settle();submitForm(h);await h.settle();replies.push({ok:true},tenant(community));step(h).props.onVerified({managementToken:'community'});await h.settle();
  assert.equal(calls[1].body.action,'create-role');assert.equal(Object.hasOwn(calls[1].body,'customerId'),false,'community: create-role sends no customerId');assert.ok(toasts.some(item=>item.text==='Rolle erstellt.'));disposeAll();
  // Separated, as a role administrator of two customers: labels, owner field, hidden portal rights.
  h=await mount('roles',view,tenant(technician));assert.deepEqual(owners(h),['MSP-Bibliothek','MSP-Bibliothek','MSP-Bibliothek','Standardkunde','Kunde B','MSP-Bibliothek'],'every role carries its owner label');
  assert.equal(menu(h,'Aktionen für Bibliothek eigen'),null,'a library role is not editable without the library right');
  assert.ok(menu(h,'Aktionen für Rolle A'),'a customer role stays editable');
  button(h,'Rolle erstellen').props.onClick();await h.settle();const ownerField=byLabel(h,'Gehört zu');
  assert.equal(ownerField.props.value,first,'the default customer is preselected');assert.deepEqual(ownerField.props.children.map(option=>option.props.value),[first,other],'without the library right only customers are offered');
  assert.match(find(h.tree,node=>node.props?.label==='Gehört zu').props.hint,/Rollen eines Kunden enthalten nur Geräteberechtigungen und gelten nur für seine Gerätegruppen und Geräte\./);
  assert.equal(find(h.tree,node=>node.type===PickCheckRow&&node.props.hint.startsWith('portal.')),null,'a customer role hides the portal rights');
  ownerField.props.onChange({target:{value:other}});await h.settle();byLabel(h,'Name').props.onChange({target:{value:'Für B'}});await h.settle();firstRight(h).props.onChange(true);await h.settle();
  submitForm(h);await h.settle();replies.push({ok:true},tenant(technician));step(h).props.onVerified({managementToken:'customer'});await h.settle();
  assert.deepEqual([calls[1].body.action,calls[1].body.customerId],['create-role',other],'create-role sends the chosen customer');disposeAll();
  // Editing shows the owner as text and never sends customerId.
  h=await mount('roles',view,tenant(technician));entry(h,'Aktionen für Rolle A','edit').onSelect();await h.settle();
  assert.ok(find(h.tree,node=>node.props?.items?.some?.(item=>item.label==='Gehört zu'&&item.value==='Standardkunde')),'the owner as a fact');assert.equal(named(h,'Gehört zu'),null,'no owner field when editing');
  find(h.tree,node=>React.isValidElement(node.props?.label)&&text(node.props.label).startsWith('Beschreibung')).props.children.props.onChange({target:{value:'Neu'}});await h.settle();
  submitForm(h);await h.settle();replies.push({ok:true},tenant(technician));step(h).props.onVerified({managementToken:'update'});await h.settle();
  assert.equal(calls[1].body.action,'update-role');assert.equal(Object.hasOwn(calls[1].body,'customerId'),false,'update-role sends no customerId');disposeAll();
  // An Owner may choose the library, which comes first.
  h=await mount('roles',view,tenant({...technician,libraryWritable:true}));button(h,'Rolle erstellen').props.onClick();await h.settle();
  assert.deepEqual(byLabel(h,'Gehört zu').props.children.map(option=>[option.props.value,text(option)]),[['','MSP-Bibliothek · alle Kunden'],[first,'Standardkunde'],[other,'Kunde B']],'the Owner gets the library first');
  assert.equal(byLabel(h,'Gehört zu').props.value,'','the Owner starts with the library');assert.ok(find(h.tree,node=>node.type===PickCheckRow&&node.props.hint.startsWith('portal.')),'a library role offers the portal rights');disposeAll();
  // Without a customer and without the library right, creating is blocked with its reason.
  h=await mount('roles',view,tenant({...technician,customers:[]}));
  assert.equal(button(h,'Rolle erstellen').props.blocked,'Dir ist kein Kunde zugewiesen. Einträge der MSP-Bibliothek legen nur Owner an.','create-role is blocked with its reason');disposeAll();
  // ScopedPermissionEditor: library roles, plus the roles of exactly the target's customer; none globally.
  h=await mount('assignments',view,tenant(technician),{type:'group',id:'devices-id'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();
  assert.deepEqual(roleOptions(h).filter(Boolean),['reader-role','role-a','library-custom'],'a group of the default customer offers library roles and its own; no Owner role for a non-Owner');disposeAll();
  h=await mount('assignments',view,tenant(technician),{type:'group',id:'b-group'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();
  assert.deepEqual(roleOptions(h).filter(Boolean),['reader-role','role-b','library-custom'],'a group of customer B offers the roles of B; no Owner role for a non-Owner');disposeAll();
  h=await mount('assignments',view,tenant(technician),{type:'device',id:'server-id'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();
  assert.deepEqual(roleOptions(h).filter(Boolean),['reader-role','role-a','library-custom'],'a device offers the roles of its customer; no Owner role for a non-Owner');disposeAll();
  h=await mount('assignments',view,tenant(technician),{type:'global'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();
  assert.deepEqual(roleOptions(h).filter(Boolean),['reader-role','uaa-role','library-custom'],'the global scope offers no customer roles; no Owner role for a non-Owner');disposeAll();
  // The cross-customer right exists once separated; roles with '*' or it are the Owner's.
  {
   const right={id:'portal.msp.crossCustomer',labelKey:'crossCustomer.right'},senior={id:'senior',name:'Senior',description:'',permissions:['view','portal.msp.crossCustomer'],builtIn:false,customerId:null,customerName:null};
   const privilegedData=(catalog,privilegedWritable=catalog.libraryWritable)=>({...tenant(catalog,privilegedWritable),permissions:[...data.permissions,right],roles:[...tenant(catalog).roles,senior]});
   const rightBox=h=>find(h.tree,node=>node.type===PickCheckRow&&node.props.hint===right.id);
   const ownerCatalog={...technician,libraryWritable:true},roleLock='Nur ein Owner kann diese Rolle ändern und zuweisen.';
   // With only the default customer the right is not offered.
   let h=await mount('roles',view,privilegedData(community));button(h,'Rolle erstellen').props.onClick();await h.settle();
   assert.equal(rightBox(h),null,'community: no cross-customer right in the role editor');disposeAll();
   // With only the default customer too, a non-Owner sees privileged roles locked with the reason and is not offered them.
   h=await mount('roles',view,privilegedData(community,false));
   assert.deepEqual([entry(h,'Aktionen für Senior','edit').blocked,entry(h,'Aktionen für Senior','delete').blocked],[roleLock,roleLock],'community: a non-Owner sees the privileged role locked');
   assert.ok(menu(h,'Aktionen für Bibliothek eigen'),'community: a plain role stays editable');disposeAll();
   h=await mount('assignments',view,privilegedData(community,false),{type:'global'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();
   assert.deepEqual(roleOptions(h).filter(Boolean),['reader-role','uaa-role','library-custom'],'community: no privileged role is offered to a non-Owner');disposeAll();
   h=await mount('assignments',view,privilegedData(community),{type:'global'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();
   assert.deepEqual(roleOptions(h).filter(Boolean),['builtin-owner','reader-role','uaa-role','library-custom','senior'],'community: the Owner assigns privileged roles');disposeAll();
   // Separated, as Owner: offered and free; the privileged role is editable and assignable.
   h=await mount('roles',view,privilegedData(ownerCatalog));button(h,'Rolle erstellen').props.onClick();await h.settle();
   let box=rightBox(h);assert.ok(box,'separated: the right is offered');assert.equal(box.props.label,'Aktionen für mehrere Kunden starten');
   assert.equal(box.props.blocked,undefined,'the Owner may grant the right');disposeAll();
   h=await mount('roles',view,privilegedData(ownerCatalog));
   assert.deepEqual([entry(h,'Aktionen für Senior','edit').blocked,entry(h,'Aktionen für Senior','delete').blocked],[undefined,undefined],'the Owner edits and deletes a privileged role');disposeAll();
   h=await mount('assignments',view,privilegedData(ownerCatalog),{type:'global'});button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();
   assert.deepEqual(roleOptions(h).filter(Boolean),['builtin-owner','reader-role','uaa-role','library-custom','senior'],'the Owner assigns privileged roles');disposeAll();
   // Separated, no Owner: the privileged role stays visible, locked with the reason, and is not assignable.
   h=await mount('roles',view,privilegedData(technician));
   assert.deepEqual([entry(h,'Aktionen für Senior','edit').blocked,entry(h,'Aktionen für Senior','delete').blocked],[roleLock,roleLock],'edit and delete are blocked with the reason');
   assert.equal(menu(h,'Aktionen für Bibliothek eigen'),null,'a plain library role stays without a menu for a non-Owner');
   // Even if the library were chosen, the right is locked for a non-Owner.
   button(h,'Rolle erstellen').props.onClick();await h.settle();byLabel(h,'Gehört zu').props.onChange({target:{value:''}});await h.settle();
   box=rightBox(h);assert.equal(box.props.blocked,'Nur ein Owner kann diese Berechtigung vergeben.','the right is blocked with its reason');disposeAll();
   for(const scope of [{type:'global'},{type:'group',id:'devices-id'}]){
    h=await mount('assignments',view,privilegedData(technician),scope);button(h,'Zuweisung hinzufügen').props.onClick();await h.settle();
    assert.equal(roleOptions(h).some(id=>id==='senior'||id==='builtin-owner'),false,`no privileged role is offered (${scope.type})`);disposeAll();
   }
  }
  // Source checks, CRLF-safe.
  const source=fs.readFileSync('ui/settings/settings-roles.tsx','utf8');
  assert.match(source,/^import '@\/ui\/base\/catalog-owner\.css';\r?$/m,'the roles page loads the owner styles');
  assert.match(source,/\.\.\.\(form\.role\?\{id:form\.role\.id\}:catalogOwnerRequest\(data\.catalog,form\.owner\)\)/,'customerId only when creating');
  assert.match(fs.readFileSync('ui/devices/configuration/permissions-tab.tsx','utf8'),/fitsCatalogOwner\(role\.customerId,scopeCustomer\)/,'assignable roles follow the target customer');
  assert.match(fs.readFileSync('ui/settings/rbac-model.ts','utf8'),/^import \{privilegedRole\} from '@\/ui\/base\/cross-customer';\r?$/m,'the model uses the shared helper');
 }
 // ---- The shared guards on their own: useGenerationState and useRbacConfirm (rbac-data.ts) ----
 {
  const rbacData=load('ui/settings/rbac-data.ts'),done=[];
  function Probe(props){const rbac=rbacData.useRbacData({viewer:props.viewer,demo:false,scopeKey:props.scopeKey,endpoint:'/api/rbac',onRefresh:()=>refreshes++});const [value,setValue]=rbacData.useGenerationState(rbac.generation);const confirm=rbacData.useRbacConfirm(rbac,{onDone:reply=>done.push(reply)});return {rbac,value,setValue,confirm};}
  const probe=async()=>{calls=[];replies=[data];const h=new Harness(Probe,{viewer:view,scopeKey:'probe'});harnesses.push(h);await h.settle();return h;};
  // useGenerationState: the value of this generation; null after a viewer change, a scope change and the session lock.
  let h=await probe();h.tree.setValue({drawer:'open'});await h.settle();
  assert.deepEqual(h.tree.value,{drawer:'open'},'the value reads in its generation');
  h.render();await h.settle();assert.deepEqual(h.tree.value,{drawer:'open'},'a render without a change keeps it');
  h.tree.setValue(current=>current&&{...current,more:true});await h.settle();assert.deepEqual(h.tree.value,{drawer:'open',more:true},'an updater gets the current value');
  const staleSetter=h.tree.setValue;
  replies.push(data);h.props={...h.props,viewer:{...view,id:'other-id',userId:'other-id'}};h.render();await h.settle();
  assert.equal(h.tree.value,null,'a viewer change reads null');
  h.tree.setValue({drawer:'new'});await h.settle();staleSetter(null);await h.settle();
  assert.deepEqual(h.tree.value,{drawer:'new'},'a null from a setter of the old generation leaves the new value alone');disposeAll();
  h=await probe();h.tree.setValue({drawer:'open'});await h.settle();replies.push(data);h.props={...h.props,scopeKey:'other-scope'};h.render();await h.settle();
  assert.equal(h.tree.value,null,'a scope change reads null');
  h.tree.confirm.ask({title:'T',body:'B',lines:[],confirmLabel:'C',tone:'danger',change:{endpoint:'/api/rbac',body:{}}});await h.settle();
  replies.push(data);h.props={...h.props,scopeKey:'probe'};h.render();await h.settle();
  assert.deepEqual([h.tree.value,h.tree.confirm.dialog.open],[null,false],'back on the first scope (the same generation key) the old value is gone, not only hidden');disposeAll();
  h=await probe();h.tree.setValue({drawer:'open'});await h.settle();window.dispatchEvent(new Event('test:lock'));await h.settle();
  assert.equal(h.tree.value,null,'the session lock reads null');disposeAll();
  // useRbacConfirm: the dialog props, hidden during the step-up, one change, no close while sending, closed after the change.
  const request={title:'Rolle löschen?',body:'Weg.',lines:[{label:'Rolle',value:'R'}],confirmLabel:'Rolle löschen',tone:'danger',change:{endpoint:'/api/rbac',body:{action:'delete-role',id:'r'},success:'Gelöscht.'}};
  h=await probe();h.tree.confirm.ask(request);await h.settle();
  const asked=h.tree.confirm.dialog;
  assert.deepEqual([asked.open,asked.title,asked.body,asked.lines,asked.confirmLabel,asked.tone,asked.busy],[true,request.title,request.body,request.lines,request.confirmLabel,'danger',false],'ask opens the dialog with its texts');
  asked.onConfirm();asked.onConfirm();await h.settle();
  assert.deepEqual([h.tree.rbac.dialog.open,h.tree.confirm.dialog.open],[true,false],'a second press runs nothing; the dialog hides while the step-up dialog is open');
  h.tree.confirm.dialog.onConfirm();await h.settle();
  const mutation=deferred();replies.push(mutation);h.tree.rbac.dialog.onVerified({managementToken:'confirm'});await h.settle();
  assert.equal(calls.filter(call=>call.body).length,1,'one change is sent');
  assert.deepEqual([h.tree.confirm.dialog.open,h.tree.confirm.dialog.busy],[true,true],'the dialog shows busy while the change is sent');
  h.tree.confirm.dialog.onOpenChange(false);await h.settle();assert.equal(h.tree.confirm.dialog.open,true,'a close while sending is ignored');
  h.tree.confirm.dialog.onConfirm();await h.settle();assert.equal(calls.filter(call=>call.body).length,1,'a confirm while busy sends nothing');
  replies.push(data);mutation.resolve({ok:true});await h.settle();
  assert.deepEqual([h.tree.confirm.dialog.open,done.at(-1)],[false,{ok:true}],'closed after the change; onDone gets the reply');disposeAll();
  h=await probe();h.tree.confirm.ask(request);await h.settle();h.tree.confirm.dialog.onConfirm();await h.settle();replies.push(new Error('kaputt'));h.tree.rbac.dialog.onVerified({managementToken:'fails'});await h.settle();
  assert.deepEqual([h.tree.confirm.dialog.open,done.at(-1)],[false,null],'a failed change closes it too; onDone gets null');disposeAll();
  h=await probe();h.tree.confirm.ask(request);await h.settle();h.tree.confirm.dialog.onOpenChange(false);await h.settle();
  assert.equal(h.tree.confirm.dialog.open,false,'a close without a change closes it');
  h.tree.confirm.ask(request);await h.settle();replies.push(data);h.props={...h.props,viewer:{...view,id:'other-id',userId:'other-id'}};h.render();await h.settle();
  assert.equal(h.tree.confirm.dialog.open,false,'a generation change closes it');disposeAll();
 }
 console.log('PASS: RBAC management actions require fresh explicit proof, do not replay after cancellation/lock/actor change, keep the drawer input on cancel and failure, reload after a refused change, keep invitation secrets transient, offer "Assign role" after a create, abort on unmount, fix grants to all-devices, group or device resources without cross-scope mutation, preserve scoped assignments, expose delegated management without device privilege, keep customer roles within their customer and leave privileged roles to Owners.');
}finally{disposeAll();}
