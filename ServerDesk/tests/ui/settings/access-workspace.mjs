// Exercise the actual AccessWorkspace and the scoped Permissions view with deterministic hooks,
// API responses and dialog leaves. No production server or browser is mutated.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';

let checks=0;
const owner={id:'owner',label:'owner@example.test',permissions:['*']};
const principals=[{id:'private:owner@example.test',label:'owner@example.test',owner:true},{id:'private:ops@example.test',label:'ops@example.test',owner:false},{id:'private:reader@example.test',label:'reader@example.test',owner:false}];
// The API sends each right as {id,labelKey} (lib/server/identity/access.ts); the panels translate the key.
const permissions=['view','diagnose','files.read','files.write','terminal','runbooks.read','runbooks.execute','drift.read','update','groups.manage'].map(id=>({id,labelKey:'permission.'+id}));
const catalog={groups:[{id:'production',name:'Produktion',description:'Produktive Systeme',deviceIds:['device-a']},{id:'testing',name:'Testlabor',description:'Tests und Entwicklung',deviceIds:['device-b']}],grants:[{id:'grant-reader',groupId:'production',principal:principals[2].id,role:'viewer',permissions:['view','files.read']},{id:'grant-ops',groupId:'production',principal:principals[1].id,role:'operator',permissions:['view','files.read','terminal','runbooks.execute','drift.read','update']},{id:'grant-test',groupId:'testing',principal:principals[2].id,role:'viewer',permissions:['view']}],permissions,principals,globalAdmin:true,canManageGroups:true,deviceIds:['device-a','device-b','device-c']};
const servers=[{id:'device-a',name:'WEB-01',permissions:['view','groups.manage'],snapshot:{hostname:'web.internal'}},{id:'device-b',name:'LAB-02',permissions:['view','groups.manage'],snapshot:{hostname:'lab.internal'}},{id:'device-c',name:'UNASSIGNED',permissions:['view'],snapshot:null}];
const clone=value=>structuredClone(value);
const jsx=(type,props,key)=>({type,props:props??{},key});
const source=filename=>ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;

function harness({filename='ui/settings/access-workspace.tsx',exportName='default',get,post,initialProps={},confirm=true}={}){
 // Plain components without hooks (InheritedOrigin with a fixed-language useT) render in place.
 const pure=new Set();
 const cells=[],effects=[],calls=[],confirmations=[],listeners=new Map(),timers=new Map(),cache=new Map();let cursor=0,dirty=false,tree,nextTimer=0,refreshes=0;
 const props={viewer:owner,servers:clone(servers),demo:false,onRefresh:()=>{refreshes++;},section:'groups',users:[{email:'ops@example.test',role:'operator'}],requests:[],saving:false,onConfirm:()=>{},onSectionChange:()=>{},...initialProps};
 const hooks={
  useState(initial){const index=cursor++;cells[index]??={value:typeof initial==='function'?initial():initial};return [cells[index].value,value=>{const next=typeof value==='function'?value(cells[index].value):value;if(!Object.is(next,cells[index].value)){cells[index].value=next;dirty=true;}}];},
  useRef(initial){const index=cursor++;cells[index]??={value:{current:initial}};return cells[index].value;},
  useCallback(fn,deps){const index=cursor++,old=cells[index];if(!old||!deps||deps.some((value,i)=>!Object.is(value,old.deps[i])))cells[index]={deps,value:fn};return cells[index].value;},
  useLayoutEffect(fn,deps){const index=cursor++,old=cells[index];if(!old||deps===undefined||deps.some((value,i)=>!Object.is(value,old.deps[i]))){old?.cleanup?.();cells[index]={deps,cleanup:fn()};}},
  useEffect(fn,deps){const index=cursor++,old=cells[index];if(!old||!deps||deps.some((value,i)=>!Object.is(value,old.deps[i])))effects.push(()=>{old?.cleanup?.();cells[index]={deps,cleanup:fn()};});}
 };
 class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
 const api=async(url,payload,signal)=>{calls.push({url,payload:payload&&clone(payload),signal});return payload?(post?post(payload,signal,ApiError):{}):(get?get(signal,ApiError):clone(catalog));};
 const window={confirm:description=>{confirmations.push(description);return typeof confirm==='function'?confirm(description):confirm;},addEventListener:(name,callback)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);},removeEventListener:(name,callback)=>listeners.get(name)?.delete(callback)};
 // The Permissions view, its body ladder and the inheritance parts (console kit files before the ui/ layout) get their own kit stubs
 // with Menu from rbacImport; the settings files get the stubs of require. Both import the same texts.
 const kitFile=absolute=>/[\\/]ui[\\/](?:devices[\\/]configuration[\\/]permissions-tab|settings[\\/]rbac-body|kit[\\/]inheritance)\.tsx$/.test(absolute);
 function load(filename){
  const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;
  const mod={exports:{}};cache.set(absolute,mod);
  const require=id=>i18nRequire(id)??(kitFile(absolute)?rbacImport(id):undefined)??(id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({}, {get:(_target,key)=>String(key)}):id==='@/ui/base/api'?{api,ApiError,message:error=>error.message,stamp:String}:id==='@/ui/session/mfa-step-up'?{MfaStepUp:'MfaStepUp'}:id==='@/ui/base/http'?{SESSION_LOCK_EVENT:'session-lock'}:id==='@/ui/settings/settings-accounts'?{default:'AccountsPage',__esModule:true}:id==='@/ui/settings/settings-user-groups'?{default:'UserGroupsPage',__esModule:true}:id==='@/ui/settings/settings-roles'?{default:'RolesPage',__esModule:true}:id==='@/ui/settings/audit-log'?{default:'AuditLogPage',__esModule:true}:id==='@/ui/settings/usage-data-page'?{default:'UsageDataPage',__esModule:true}:id==='@/ui/settings/customers-panel'?{default:'CustomersPanel',__esModule:true}:id==='@/ui/settings/branding-page'?{default:'BrandingPage',__esModule:true}:id==='@/ui/settings/session-settings-panel'?{default:'SessionSettingsPanel',__esModule:true}:id==='@/ui/settings/maintenance-panel'?{default:'MaintenancePanel',__esModule:true}:id==='@/ui/settings/notifications-panel'?{default:'NotificationsPanel',__esModule:true}:id==='@/ui/settings/vulnerabilities-panel'?{default:'VulnerabilitiesPanel',__esModule:true}:id==='@/ui/settings/assistant-settings-panel'?{default:'AssistantSettingsPanel',__esModule:true}:id==='@/ui/settings/entra-settings-panel'?{default:'EntraSettingsPanel',__esModule:true}:id==='@/lib/errors/codes'?load('lib/errors/codes.ts'):id==='@/lib/step-up'?load('lib/step-up.ts'):id==='@/ui/base/access-capabilities'?load('ui/base/access-capabilities.ts'):id==='@/lib/console-route'?load('lib/console-route.ts'):id==='@/ui/shell/page-frame'?load('ui/shell/page-frame.ts'):id.endsWith('.css')?{}:id==='@/ui/settings/access-model'?load('ui/settings/access-model.ts'):id==='@/ui/devices/fleet/customer-choice'?load('ui/devices/fleet/customer-choice.ts'):id==='@/ui/base/catalog-owner'?load('ui/base/catalog-owner.ts'):id==='@/ui/settings/rbac-account-text'?load('ui/settings/rbac-account-text.ts'):id==='@/ui/base/cross-customer'?load('ui/base/cross-customer.ts'):id==='@/lib/cross-customer-right'?load('lib/cross-customer-right.ts'):id==='@/lib/default-customer'?load('lib/default-customer.ts'):id==='@/ui/kit/inheritance'?inheritance():id==='sonner'?{toast:{success(){},error(){}}}:id==='@/ui/kit/kit'?{Btn:'Btn',Card:'Card',Drawer:'Drawer',Facts:'Facts',IconBtn:'IconBtn',Notice:'Notice',SectionHead:'SectionHead',Skeleton:'Skeleton',SettingsPage:'SettingsPage',Unavailable:'Unavailable',cx:(...names)=>names.filter(Boolean).join(' ')}:id==='@/ui/kit/data-table'?{DataTable:'DataTable',Toolbar:'Toolbar'}:id==='@/ui/kit/analysis-tab'?{AnalysisTab:'AnalysisTab'}:id==='@/ui/kit/confirm-dialog'?{ConfirmDialog:'ConfirmDialog'}:id==='@/ui/kit/field'?{Field:'Field'}:id==='@/ui/base/locale'&&absolute.endsWith('inheritance.tsx')?{useT:()=>(key,params)=>load('lib/i18n/translate.ts').translate('de',key,params)}:id==='./messages/en'?load('lib/i18n/messages/en.ts'):id==='./messages/de'?load('lib/i18n/messages/de.ts'):id==='@/ui/base/locale'&&absolute.endsWith('translate.ts')?load('lib/i18n/locale.ts'):rbacImport(id)??(()=>{throw Error('Unexpected import '+id);})());
  new Function('require','module','exports','window','setTimeout','clearTimeout',source(absolute))(require,mod,mod.exports,window,(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},id=>timers.delete(id));return mod.exports;
 }
 // The Permissions view (ui/devices/configuration/permissions-tab.tsx): its kit parts as string types, its model, hook and helpers for real.
 function rbacImport(id){
  const parts={'@/ui/kit/kit':{Btn:'Btn',Card:'Card',Drawer:'Drawer',DrawerCancel:'DrawerCancel',Facts:'Facts',Menu:'Menu',Unavailable:'Unavailable',cx:(...names)=>names.filter(Boolean).join(' ')},'@/ui/kit/analysis-tab':{AnalysisTab:'AnalysisTab',FirstLoad:'FirstLoad',LoadFailed:'LoadFailed',ResetAction:'ResetAction'},'@/ui/kit/data-table':{DataTable:'DataTable',Toolbar:'Toolbar'},'@/ui/kit/confirm-dialog':{ConfirmDialog:'ConfirmDialog'},'@/ui/kit/field':{Field:'Field',Select:'Select'},'@/ui/session/mfa-step-up':{MfaStepUp:'MfaStepUp'}};
  const files={'@/ui/base/access-capabilities':'ui/base/access-capabilities.ts','@/ui/settings/access-model':'ui/settings/access-model.ts','@/ui/base/catalog-owner':'ui/base/catalog-owner.ts','@/ui/settings/rbac-account-text':'ui/settings/rbac-account-text.ts','@/ui/shell/page-frame':'ui/shell/page-frame.ts','@/ui/settings/rbac-data':'ui/settings/rbac-data.ts','@/ui/settings/rbac-body':'ui/settings/rbac-body.tsx','@/ui/settings/rbac-model':'ui/settings/rbac-model.ts','@/ui/session/step-up-retry':'ui/session/step-up-retry.ts','@/lib/account-display':'lib/account-display.ts'};
  return parts[id]??(id==='@/ui/kit/inheritance'?inheritance():files[id]?load(files[id]):undefined);
 }
 function inheritance(){const mod=load('ui/kit/inheritance.tsx');pure.add(mod.InheritedOrigin);pure.add(mod.InheritedNotEffective);return mod;}
 // A wrapper export (ScopedPermissionEditor) renders the component it returns.
 const exported=load(filename)[exportName],Component=exportName==='default'?exported:props=>{let out=exported(props);while(out&&typeof out.type==='function')out=out.type(out.props);return out;};
 function nodes(node){if(arguments.length===0)node=tree;if(!node||typeof node!=='object')return [];if(pure.has(node.type))return [node,...nodes(node.type(node.props))];if(node.type==='Dialog'&&!node.props.open)return [node];return [node,...[node.props?.children].flat(Infinity).flatMap(child=>nodes(child))];}
 function text(node){if(arguments.length===0)node=tree;if(typeof node==='string'||typeof node==='number')return String(node);if(!node||typeof node!=='object')return '';if(pure.has(node.type))return text(node.type(node.props));if(node.type==='Dialog'&&!node.props.open)return '';if(node.type==='ErrorNote')return node.props.error??'';return [node.props?.children].flat(Infinity).map(child=>text(child)).join('');}
 function render(){let limit=0;do{dirty=false;cursor=0;tree=Component(props);for(const effect of effects.splice(0))effect();if(limit++>12)throw Error('Unstable render');}while(dirty);}
 const all=predicate=>nodes().filter(predicate),find=predicate=>all(predicate)[0];
 const byLabel=label=>find(node=>node.props['aria-label']===label);
 const button=label=>find(node=>['Button','button'].includes(node.type)&&text(node)===label);
 const change=(label,value)=>{const node=byLabel(label);assert.ok(node,'Missing control '+label);node.props.onChange({target:{value}});render();};
 async function settle(predicate){for(let n=0;n<70;n++){await new Promise(resolve=>setImmediate(resolve));if(dirty)render();if(!predicate||predicate())return;}throw Error('State did not settle: '+text());}
 async function drain(){for(let n=0;n<8;n++)await settle();}
 const unmount=()=>{for(const cell of cells)cell?.cleanup?.();};
 render();return {props,calls,confirmations,listeners,timers,render,find,all,byLabel,button,change,settle,drain,unmount,text,get refreshes(){return refreshes;},dispatch:name=>{for(const callback of listeners.get(name)??[])callback();render();},model:load('ui/settings/access-model.ts')};
}

// AccessWorkspace renders the section page of #settings/<page> directly: no wrapper, no hidden tab list. Its section ids
// are the SettingsPage names; the navigator, not this component, moves between the pages.
let ui=harness({filename:'ui/settings/access-workspace.tsx',initialProps:{section:'accounts',frame:{header:primary=>({type:'PageHeader',props:{primary}}),refresh:0,tab:'',onTab(){}}}});
const pageTypes={accounts:'AccountsPage','user-groups':'UserGroupsPage',roles:'RolesPage'},rbacPage=()=>ui.find(node=>Object.values(pageTypes).includes(node.type));
const noWrapper=()=>ui.all(node=>node.type==='nav'||node.type==='button'||/sd-access-workspace|sd-identity-tabs|^panel/.test(node.props?.className??'')).length===0;
const denied=()=>{const page=ui.find(node=>node.type==='SettingsPage'),notice=ui.find(node=>node.type==='Unavailable');return !!page&&!!notice&&notice.props.reason==='right'&&ui.text(notice)==='Du brauchst die Verwaltungsberechtigung, um diese Seite zu öffnen.'&&ui.all(node=>node.type==='PageHeader').length===1;};
const accountPanel=rbacPage();assert.equal(accountPanel.type,'AccountsPage');assert.equal(accountPanel.props.frame,ui.props.frame,'the page gets the console frame');assert.equal(typeof accountPanel.props.onRefresh,'function');assert.ok(noWrapper(),'no wrapper, tab list or tab button around the page');checks+=4;
assert.doesNotMatch(fs.readFileSync('ui/settings/access-workspace.tsx','utf8'),/onSectionChange|administrationTabs/,'AccessWorkspace takes no section change and builds no tab list');checks++;
for(const section of ['user-groups','roles']){ui.props.section=section;ui.render();const panel=rbacPage();assert.equal(panel.type,pageTypes[section]);assert.equal(panel.props.frame,ui.props.frame);assert.notEqual(panel.key,accountPanel.key,'route changes remount forms and pending proof');assert.ok(noWrapper());checks+=4;}
const auditEntry={id:1,at:1700000000000,actor:'owner',action:'Konto erstellt',target:'support',serverId:null,scope:'portal'};
ui.props.section='audit';ui.props.entries=[auditEntry];ui.props.demo=true;ui.render();assert.deepEqual(ui.find(node=>node.type==='AuditLogPage').props.entries,[auditEntry],'demo mode: the audit log gets the real portal entries');checks++;ui.props.demo=false;ui.render();assert.equal(rbacPage(),undefined);assert.deepEqual(ui.find(node=>node.type==='AuditLogPage').props.entries,[auditEntry]);assert.equal(ui.find(node=>node.type==='AuditLogPage').props.loading,false);ui.props.auditLoading=true;ui.render();assert.equal(ui.find(node=>node.type==='AuditLogPage').props.loading,true,'the console first load reaches the page, which shows its table Skeleton');assert.equal(ui.find(node=>node.type==='AuditLogPage').props.frame,ui.props.frame,'the page gets the console frame');checks+=4;
// The usage data page belongs to global Owners only and replaces the access pages.
ui.props.section='usage-data';ui.props.auditLoading=false;ui.render();assert.ok(ui.find(node=>node.type==='UsageDataPage'),'an Owner sees the usage data page');assert.equal(ui.find(node=>node.type==='UsageDataPage').props.frame,ui.props.frame);assert.equal(rbacPage(),undefined);assert.equal(ui.find(node=>node.type==='AuditLogPage'),undefined);checks+=4;
ui.props.viewer={...owner,permissions:['*']};ui.render();assert.ok(ui.find(node=>node.type==='UsageDataPage'),'the global Owner right opens the usage data page');checks++;
// The customers page belongs to global Owners only as well.
ui.props.section='customers';ui.render();assert.ok(ui.find(node=>node.type==='CustomersPanel'),'an Owner sees the customers page');assert.equal(ui.find(node=>node.type==='CustomersPanel').props.viewer,ui.props.viewer);assert.equal(rbacPage(),undefined);assert.equal(ui.find(node=>node.type==='UsageDataPage'),undefined);checks+=4;
ui.props.viewer=owner;ui.render();assert.ok(ui.find(node=>node.type==='CustomersPanel'),'the Owner right opens the customers page');checks++;
const delegated={...owner,permissions:['portal.users.manage','portal.userGroups.manage','portal.roles.manage','portal.roleAssignments.manage']};
ui.props.viewer=delegated;ui.render();assert.equal(ui.find(node=>node.type==='CustomersPanel'),undefined,'delegated portal rights do not open customers');assert.ok(denied(),'no permission: the page header, then SettingsPage with the kit Unavailable');assert.ok(noWrapper(),'and no classic panel');checks+=3;
ui.props.viewer={...owner,permissions:['*']};ui.props.section='usage-data';ui.render();
ui.props.viewer=delegated;ui.render();assert.equal(ui.find(node=>node.type==='UsageDataPage'),undefined,'all delegated portal rights are not Owner');assert.ok(denied());checks+=2;
// Branding (docs/branding.md) is for global Owners; a direct link of anyone else shows the header and Unavailable.
ui.props.viewer={...owner,permissions:['*']};ui.props.section='branding';ui.render();assert.deepEqual(Object.keys(ui.find(node=>node.type==='BrandingPage').props).sort(),['consoleBackgroundOn','frame','onChanged'],'an Owner opens Branding with the frame, the console refresh and the own console background preference');assert.equal(ui.find(node=>node.type==='BrandingPage').props.frame,ui.props.frame);checks+=2;
ui.props.viewer=delegated;ui.render();assert.equal(ui.find(node=>node.type==='BrandingPage'),undefined,'delegated portal rights do not open Branding');assert.ok(denied(),'no permission: the page header, then Unavailable');checks+=2;
// Sessions (automatic sign-out) follows the instance settings rule: '*' sees it, a User Access Administrator does not.
ui.props.viewer={...owner,permissions:['*']};ui.props.section='sessions';ui.props.demo=true;ui.render();assert.deepEqual(ui.find(node=>node.type==='SessionSettingsPanel').props,{viewer:ui.props.viewer,frame:ui.props.frame},'demo mode blocks nothing on Sessions: the page gets no demo flag');assert.equal(rbacPage(),undefined);checks+=2;ui.props.demo=false;
ui.props.section='retention';ui.render();assert.deepEqual(ui.find(node=>node.type==='MaintenancePanel').props,{viewer:ui.props.viewer,frame:ui.props.frame},'an Owner opens Data retention');checks++;
ui.props.section='notification-channels';ui.render();assert.deepEqual(ui.find(node=>node.type==='NotificationsPanel').props,{viewer:ui.props.viewer,frame:ui.props.frame},'an Owner opens Notification channels');checks++;
ui.props.viewer=delegated;ui.props.section='retention';ui.render();assert.equal(ui.find(node=>node.type==='MaintenancePanel'),undefined,'a non-Owner does not open Data retention');assert.ok(denied(),'a direct hash shows access.noPermission');checks+=2;
ui.props.section='vulnerabilities';ui.render();assert.equal(ui.find(node=>node.type==='VulnerabilitiesPanel'),undefined,'a non-Owner does not open the vulnerability check');assert.ok(denied());checks+=2;
ui.props.viewer={...owner,permissions:['*']};ui.render();assert.deepEqual(ui.find(node=>node.type==='VulnerabilitiesPanel').props,{viewer:ui.props.viewer,frame:ui.props.frame});checks++;
ui.props.viewer=delegated;
ui.props.section='sessions';ui.render();assert.equal(ui.find(node=>node.type==='SessionSettingsPanel'),undefined,'a User Access Administrator does not open Sessions');assert.ok(denied());checks+=2;
ui.props.section='audit';ui.props.auditLoading=true;
ui.props.viewer={...owner,permissions:['portal.users.manage'],canManageDeviceGroups:false};ui.render();assert.equal(ui.find(node=>node.type==='AuditLogPage'),undefined);assert.ok(denied());checks+=2;
ui.props.section='accounts';ui.render();assert.equal(rbacPage().type,'AccountsPage','delegated account administrators reach accounts without devicegroup management');checks++;
ui.props.viewer={...ui.props.viewer,permissions:['portal.userGroups.manage']};ui.props.section='user-groups';ui.render();assert.equal(rbacPage().type,'UserGroupsPage');checks++;
ui.props.viewer={...ui.props.viewer,permissions:['portal.roles.manage']};ui.props.section='roles';ui.render();assert.equal(rbacPage().type,'RolesPage');checks++;
ui.props.viewer={...ui.props.viewer,permissions:[]};ui.render();assert.equal(rbacPage(),undefined,'rights loss immediately removes the selected privileged panel');assert.ok(denied());checks+=2;
ui.props.viewer={...ui.props.viewer,canManageDeviceGroups:true};ui.props.section='accounts';ui.render();assert.equal(rbacPage(),undefined,'device grouping does not grant account management');checks++;ui.unmount();
// The old section ids are gone from the model: canOpenAccessSection takes the page names.
{
 const capabilities=await import('../../../ui/base/access-capabilities.ts');
 for(const [section,viewer,expected] of [['user-groups',{permissions:['portal.userGroups.manage']},true],['sessions',{permissions:['*']},true],['retention',{permissions:['*']},true],['notification-channels',{permissions:['portal.notifications.manage']},true],['sessions',{permissions:['portal.users.manage']},false],['retention',{permissions:['portal.users.manage']},false]])assert.equal(capabilities.canOpenAccessSection(viewer,section),expected,`${section} for ${viewer.permissions}`);
 checks+=6;
}

// Accounts, User groups and Roles (their capability gates, tables, menus and drawers) are tested in
// tests/ui/settings/settings-rbac-pages.mjs and tests/ui/settings/rbac-management-actions.mjs; the Permissions view follows below.
const rbacCatalog={users:[{id:'owner',username:'owner',displayName:'Owner',email:null,status:'active',mfaEnabled:true,passwordSet:true}],userGroups:[{id:'ops',name:'Operations',description:'Support team',enabled:true,userIds:[]}],roles:[{id:'reader',name:'Reader',description:'Read devices',permissions:['view'],builtIn:true}],assignments:[{id:'assignment',subjectType:'user',subjectId:'owner',roleId:'reader',scopeType:'global',scopeId:'*'}],deviceGroups:[],devices:[],permissions:[{id:'view',labelKey:'permission.view'}],canManage:true,canManageUsers:false,canManageAssignments:true,canManageUserGroups:false,canManageRoles:false};
// A device or group editor also lists the assignments inherited there, read-only, in server order.
{
 const users=[{id:'owner',username:'owner',displayName:'Owner',email:null,status:'active'},{id:'invited',username:'invited',displayName:'Ina Invited',email:null,status:'invited'},{id:'disabled',username:'disabled',displayName:'Dora Disabled',email:null,status:'disabled'}];
 const userGroups=[{id:'ops',name:'Operations',description:'',enabled:true,userIds:[]},{id:'off',name:'Altgruppe',description:'',enabled:false,userIds:[]}];
 const direct={id:'a-direct',subjectType:'user',subjectId:'owner',roleId:'reader',scopeType:'device',scopeId:'device-a'},child={id:'a-child',subjectType:'group',subjectId:'off',roleId:'reader',scopeType:'devicegroup',scopeId:'g-child'},parent={id:'a-parent',subjectType:'user',subjectId:'invited',roleId:'operator',scopeType:'devicegroup',scopeId:'g-parent'},global={id:'a-global',subjectType:'user',subjectId:'disabled',roleId:'reader',scopeType:'global',scopeId:'*'},active={id:'a-active',subjectType:'group',subjectId:'ops',roleId:'reader',scopeType:'global',scopeId:'*'};
 const base={...clone(rbacCatalog),users,userGroups,roles:[...rbacCatalog.roles,{id:'operator',name:'Operator',description:'Operate devices',permissions:['view','terminal'],builtIn:true}],deviceGroups:[{id:'g-parent',name:'Standort',parentId:null},{id:'g-child',name:'Berlin',parentId:'g-parent'}],devices:[{id:'device-a',name:'WEB-01'}]};
 // Effective flags; a-parent keeps the plain shape without the key.
 const inherited=[{assignmentId:'a-child',originType:'devicegroup',originId:'g-child',effective:false,reason:'group-disabled'},{assignmentId:'a-parent',originType:'devicegroup',originId:'g-parent'},{assignmentId:'a-global',originType:'global',originId:'*',effective:false,reason:'user-inactive'},{assignmentId:'a-active',originType:'global',originId:'*',effective:true},{assignmentId:'a-hidden',originType:'global',originId:'*',effective:true}];
 const opened=[];
 const editor=(catalogValue,scope={type:'device',id:'device-a'},extra={onOpenScope:target=>opened.push(target)})=>harness({filename:'ui/devices/configuration/permissions-tab.tsx',exportName:'ScopedPermissionEditor',get:()=>clone(catalogValue),initialProps:{scope,scopeName:'WEB-01',...extra}});
 // The Permissions view is built from kit parts (string types here): the Toolbar search, a Card per
 // section and a DataTable each, whose rows are read through their columns' cells.
 const card=(ui,title)=>ui.find(node=>node.type==='Card'&&node.props.title===title);
 const section=ui=>card(ui,'Geerbt');
 const tableIn=(ui,node)=>node&&ui.all(entry=>entry.type==='DataTable').find(entry=>[node.props.children].flat(Infinity).includes(entry));
 const directTable=ui=>tableIn(ui,card(ui,'Direkt'));
 const cellsOf=(table,row)=>table.props.columns.map(column=>column.cell(row));
 const bodyRows=(ui,node)=>{const table=tableIn(ui,node);return table?table.props.rows.map(row=>cellsOf(table,row)):[];};
 const rowText=(ui,cells)=>cells.map(cell=>ui.text(cell)).join('');
 const search=ui=>ui.find(node=>node.type==='Toolbar').props.search;
 const setSearch=(ui,value)=>{search(ui).onChange(value);ui.render();};
 const ready=ui=>()=>!!ui.find(node=>node.type==='Toolbar');
 const iconCells=ui=>ui.all(node=>node.type==='DataTable').flatMap(table=>table.props.rows.flatMap(row=>cellsOf(table,row))).filter(cell=>cell?.type==='IconBtn');
 const menuEntries=(ui,node)=>bodyRows(ui,node).map(cells=>cells.find(cell=>cell?.type==='Menu')?.props.entries.map(entry=>entry.label)??[]);
 ui=editor({...base,assignments:[direct,child,parent,global,active],inherited});await ui.settle(ready(ui));
 assert.equal(ui.calls[0].url,'/api/rbac?scopeType=device&scopeId=device-a','the device editor asks for its inherited assignments');checks++;
 assert.equal(search(ui).label,'Berechtigungen suchen','one search above both cards');checks++;
 let inheritedRows=bodyRows(ui,section(ui)).map(cells=>rowText(ui,cells));
 assert.equal(inheritedRows.length,4,'one row per inherited entry whose assignment is listed; a-hidden is left out');
 assert.match(inheritedRows[0],/^AltgruppeBenutzergruppe · DeaktiviertReaderGeerbtGerätegruppe: BerlinÄndern oder entfernen kannst du das nur dort, wo es festgelegt ist\.$/);
 assert.match(inheritedRows[1],/^Ina InvitedKonto · Aktivierung ausstehendOperatorGeerbtGerätegruppe: Standort/);
 assert.match(inheritedRows[2],/^Dora DisabledKonto · DeaktiviertReaderGeerbtAlle Geräte/);
 assert.match(inheritedRows[3],/^OperationsBenutzergruppeReaderGeerbtAlle Geräte/,'an active user group keeps the plain text');checks+=5;
 // The inactive-subject marker is the reason for a disabled group or account; effective and unflagged rows stay plain.
 const rowClasses=ui=>bodyRows(ui,section(ui)).map(cells=>cells[0].props.className.includes('sdx-inherited-ineffective')&&cells[1].props.className.includes('sdx-inherited-ineffective')?'sdx-inherited-ineffective':undefined);
 assert.deepEqual(rowClasses(ui),['sdx-inherited-ineffective',undefined,'sdx-inherited-ineffective',undefined],'only the non-effective rows are muted (subject and role)');
 assert.doesNotMatch(inheritedRows.join(''),/Wirkt nicht/,'user-inactive and group-disabled add no reason line');checks+=2;
 assert.deepEqual([section(ui).props.icon!==undefined,tableIn(ui,section(ui)).props.label,tableIn(ui,section(ui)).props.columns.map(column=>column.label)],[true,'Geerbte Rollenzuweisungen',['Konto oder Benutzergruppe','Rolle','Herkunft','Aktionen']],'heading and columns of the inherited card, with the row menu column');checks++;
 assert.deepEqual(directTable(ui).props.columns.map(column=>column.label),['Konto oder Benutzergruppe','Rolle','Aktionen'],'the direct table has no Scope column');checks++;
 const directRows=bodyRows(ui,card(ui,'Direkt'));assert.equal(directRows.length,1);assert.match(rowText(ui,directRows[0]),/^OwnerKontoReader/,'an active account keeps the plain text');checks+=2;
 assert.deepEqual(iconCells(ui),[],'no IconBtn in any row');assert.deepEqual(menuEntries(ui,card(ui,'Direkt')),[['Zuweisung entfernen…']],'the direct row menu removes the assignment');
 assert.deepEqual(menuEntries(ui,section(ui)),[['Ursprung öffnen'],['Ursprung öffnen'],['Ursprung öffnen'],['Ursprung öffnen']],'every inherited row (All devices or a group) opens its origin from its menu');
 // An assignment from the Entra role sync carries the "Aus Entra" tag, and its remove button names the mapping as the reason.
 const entraCells=cellsOf(directTable(ui),{...directTable(ui).props.rows[0],source:'entra'}),plainCells=cellsOf(directTable(ui),directTable(ui).props.rows[0]);
 assert.equal(ui.text(entraCells[1]),'Reader Aus Entra','the role cell of an Entra assignment shows the tag');assert.equal(ui.text(plainCells[1]),'Reader','a manual assignment has no tag');
 assert.equal(entraCells[2].props.entries[0].blocked,'Diese Zuweisung stammt aus einer Entra-Gruppenzuordnung. Ändere sie unter Einstellungen → Microsoft Entra ID.','remove is blocked with the mapping reason');assert.equal(plainCells[2].props.entries[0].blocked,undefined,'a manual assignment stays removable');checks+=4;
 assert.ok(bodyRows(ui,section(ui)).every(cells=>cells[3].props.entries.every(entry=>!entry.danger&&entry.label==='Ursprung öffnen')),'inherited rows have no edit or remove entry');checks+=2;
 bodyRows(ui,section(ui))[0][3].props.entries[0].onSelect();assert.deepEqual(opened.splice(0),[{type:'group',id:'g-child',name:'Berlin'}],'"Open origin" opens the origin');checks++;
 const origins=bodyRows(ui,section(ui)).map(cells=>cells[2]);
 origins[0].props.onOpen();origins[2].props.onOpen();
 assert.deepEqual(opened,[{type:'group',id:'g-child',name:'Berlin'},{type:'global',name:'Alle Geräte'}],'the origin link opens the group or Alle Geräte');checks++;
 setSearch(ui,'Standort');inheritedRows=bodyRows(ui,section(ui)).map(cells=>rowText(ui,cells));
 assert.equal(inheritedRows.length,1);assert.match(inheritedRows[0],/Gerätegruppe: Standort/);assert.equal(directTable(ui).props.empty.title,'Keine passende direkte Rollenzuweisung.');assert.equal(directTable(ui).props.empty.action.props.label,'Suche löschen');checks+=4;
 setSearch(ui,'Owner');assert.equal(section(ui),undefined,'the search filters the inherited section too');assert.equal(bodyRows(ui,card(ui,'Direkt')).length,1);checks+=2;
 setSearch(ui,'zzz');assert.equal(section(ui),undefined);assert.equal(directTable(ui).props.empty.title,'Keine passende Rollenzuweisung');checks+=2;
 directTable(ui).props.empty.action.props.onReset();ui.render();assert.equal(search(ui).value,'','"Clear search" empties the search');checks++;ui.unmount();
 ui=editor({...base,assignments:[child,parent,global],inherited});await ui.settle(ready(ui));
 assert.deepEqual([directTable(ui).props.empty.title,directTable(ui).props.empty.children],['Keine direkten Rollenzuweisungen','Die geerbten Zuweisungen stehen unten. Füge eine Zuweisung hinzu, um Berechtigungen nur hier zu vergeben.']);assert.ok(section(ui));
 const cards=ui.all(node=>node.type==='Card').map(node=>node.props.title);assert.deepEqual(cards,['Direkt','Geerbt'],'the Direct card first, then the Inherited card');checks+=3;ui.unmount();
 ui=editor({...base,assignments:[],inherited:[]},{type:'group',id:'g-child'});await ui.settle(ready(ui));
 assert.equal(ui.calls[0].url,'/api/rbac?scopeType=devicegroup&scopeId=g-child','the group editor asks with scopeType devicegroup');
 assert.deepEqual([directTable(ui).props.empty.title,directTable(ui).props.empty.children],['Hier gilt noch keine Rollenzuweisung','Füge eine Zuweisung hinzu, um einem Konto oder einer Benutzergruppe hier Berechtigungen zu geben.']);assert.equal(section(ui),undefined);checks+=3;ui.unmount();
 ui=editor({...base,assignments:[child,parent],inherited},{type:'device',id:'device-a'},{});await ui.settle(ready(ui));
 assert.equal(bodyRows(ui,section(ui))[0][2].props.onOpen,undefined,'without onOpenScope the origin is plain text');assert.equal(tableIn(ui,section(ui)).props.columns.some(column=>column.id==='actions'),false,'and the row has no menu');assert.match(rowText(ui,bodyRows(ui,section(ui))[0]),/Gerätegruppe: Berlin/);checks+=2;ui.unmount();
 ui=editor({...base,assignments:[child],inherited},{type:'global'});await ui.settle(ready(ui));
 assert.equal(ui.calls[0].url,'/api/rbac','Alle Geräte keeps the plain request');assert.equal(section(ui),undefined,'Alle Geräte has no inherited section');assert.equal(directTable(ui).props.empty.title,'Noch keine Rollenzuweisungen');
 setSearch(ui,'zzz');assert.equal(directTable(ui).props.empty.title,'Keine passende Rollenzuweisung');checks+=4;ui.unmount();
 // Entries that give no rights show the reason from the server below the subject kind.
 {
  const carl={id:'carl',username:'carl',displayName:'Carl Customer',email:null,status:'active'};
  const groups=[...userGroups,{id:'team',name:'Team B',description:'',enabled:true,userIds:['carl']},{id:'empty',name:'Leer',description:'',enabled:true,userIds:[]}];
  const roles=[...base.roles,{id:'portal',name:'Kontoverwaltung',description:'',permissions:['portal.users.manage'],builtIn:false}];
  const rows=[{id:'n-user',subjectType:'user',subjectId:'carl',roleId:'reader',scopeType:'global',scopeId:'*'},{id:'n-group',subjectType:'group',subjectId:'team',roleId:'reader',scopeType:'devicegroup',scopeId:'g-parent'},{id:'n-role',subjectType:'user',subjectId:'owner',roleId:'portal',scopeType:'global',scopeId:'*'},{id:'n-empty',subjectType:'group',subjectId:'empty',roleId:'reader',scopeType:'global',scopeId:'*'},{id:'n-ok',subjectType:'group',subjectId:'ops',roleId:'reader',scopeType:'global',scopeId:'*'},global];
  const flags=[{assignmentId:'n-group',originType:'devicegroup',originId:'g-parent',effective:false,reason:'group-customer'},{assignmentId:'n-user',originType:'global',originId:'*',effective:false,reason:'user-customer'},{assignmentId:'n-role',originType:'global',originId:'*',effective:false,reason:'role'},{assignmentId:'n-empty',originType:'global',originId:'*',effective:false,reason:'group-empty'},{assignmentId:'n-ok',originType:'global',originId:'*',effective:true},{assignmentId:'a-global',originType:'global',originId:'*',effective:false,reason:'user-inactive'}];
  ui=editor({...base,users:[...users,carl],userGroups:groups,roles,assignments:rows,inherited:flags});await ui.settle(ready(ui));
  const texts=bodyRows(ui,section(ui)).map(cells=>rowText(ui,cells));
  assert.deepEqual(rowClasses(ui),['sdx-inherited-ineffective','sdx-inherited-ineffective','sdx-inherited-ineffective','sdx-inherited-ineffective',undefined,'sdx-inherited-ineffective'],'server order; the class on every non-effective row');
  assert.match(texts[0],/^Team BBenutzergruppeWirkt nicht: Kein Mitglied der Benutzergruppe ist dem Kunden zugeordnet\.ReaderGeerbtGerätegruppe: Standort/);
  assert.match(texts[1],/^Carl CustomerKontoWirkt nicht: Das Konto ist dem Kunden nicht zugeordnet\.ReaderGeerbtAlle Geräte/);
  assert.match(texts[2],/^OwnerKontoWirkt nicht: Die Rolle enthält keine Geräteberechtigungen\.KontoverwaltungGeerbtAlle Geräte/);
  assert.match(texts[3],/^LeerBenutzergruppeWirkt nicht: Die Benutzergruppe hat keine aktiven Mitglieder\.ReaderGeerbtAlle Geräte/);
  assert.match(texts[4],/^OperationsBenutzergruppeReaderGeerbtAlle Geräte/,'an effective row has no reason line');
  assert.match(texts[5],/^Dora DisabledKonto · DeaktiviertReaderGeerbtAlle Geräte/,'user-inactive shows only the marker');assert.doesNotMatch(texts[5],/Wirkt nicht/);checks+=8;
  // The reason sits in the subject cell, below the subject kind, as a small line.
  const subject=bodyRows(ui,section(ui))[1][0],parts=[subject.props.children].flat().flatMap(node=>node?.type==='Fragment'?[node.props.children].flat():[node]).filter(Boolean);
  assert.deepEqual(parts.map(node=>typeof node.type==='function'?node.type.name:node.type),['strong','small','InheritedNotEffective'],'subject kind first, then the reason');
  assert.equal(ui.text(subject),'Carl CustomerKontoWirkt nicht: Das Konto ist dem Kunden nicht zugeordnet.');checks+=2;
  setSearch(ui,'Wirkt nicht');assert.equal(section(ui),undefined,'the search does not match the reason text');
  setSearch(ui,'Carl');assert.equal(bodyRows(ui,section(ui)).length,1,'the search still finds the subject');checks+=2;ui.unmount();
  for(const [reason,expected] of [['role','Wirkt nicht: Die Rolle enthält keine Geräteberechtigungen.'],['group-empty','Wirkt nicht: Die Benutzergruppe hat keine aktiven Mitglieder.'],['user-customer','Wirkt nicht: Das Konto ist dem Kunden nicht zugeordnet.'],['group-customer','Wirkt nicht: Kein Mitglied der Benutzergruppe ist dem Kunden zugeordnet.'],['user-inactive',''],['group-disabled','']]){
   const alone=harness({filename:'ui/kit/inheritance.tsx',exportName:'InheritedNotEffective',initialProps:{reason}});
   assert.equal(alone.text(),expected,'InheritedNotEffective '+reason);
   if(expected)assert.equal(alone.find(node=>node.type==='small').props.className,'sdx-inherited-reason');else assert.equal(alone.all(()=>true).length,0,reason+' renders nothing');
   checks+=2;
  }
 }
 const origin=harness({filename:'ui/kit/inheritance.tsx',exportName:'InheritedOrigin',initialProps:{label:'Gerätegruppe: Berlin',onOpen:()=>{}}});
 const link=origin.byLabel('Gerätegruppe: Berlin öffnen');assert.equal(link.type,'button');assert.equal(link.props.type,'button');assert.equal(link.props.className,'sdx-inherited-link');
 assert.equal(origin.find(node=>node.props?.className==='sdx-tag').props.children,'Geerbt');assert.equal(origin.find(node=>node.type==='small').props.children,'Ändern oder entfernen kannst du das nur dort, wo es festgelegt ist.');checks+=5;
 // One InheritedReason (lib/server/identity/inherited-reason.ts, import-free) for the server and the client; neither declares the union itself.
 const shared={exports:{}};new Function('require','module','exports',source('lib/server/identity/inherited-reason.ts'))(id=>{throw Error('Unexpected import '+id);},shared,shared.exports);
 assert.deepEqual([...shared.exports.inheritedReasons],['role','user-inactive','group-disabled','group-empty','user-customer','group-customer'],'the six reasons in their order');checks++;
 for(const [file,module] of [['lib/server/identity/rbac.ts','./inherited-reason'],['ui/kit/inheritance.tsx','@/lib/server/identity/inherited-reason']]){
  const text=fs.readFileSync(file,'utf8');
  assert.doesNotMatch(text,/'(?:role|user-inactive|group-disabled|group-empty|user-customer|group-customer)'\s*\|/,file+' declares no literal reason union');
  assert.ok(text.includes(`from '${module}'`),file+' imports InheritedReason from '+module);checks+=2;
 }
 assert.doesNotMatch(fs.readFileSync('ui/kit/inheritance.tsx','utf8'),/from '(?:@\/lib\/server\/identity\/rbac|\.\.\/\.\.\/lib\/server\/identity\/rbac|@\/lib\/server\/context)'/,'the client imports no server module');checks++;
}
// The permission categories of the role drawer (ui/settings/access-model.ts).
const model=(()=>{const mod={exports:{}};new Function('require','module','exports',source('ui/settings/access-model.ts'))(id=>{throw Error('Unexpected import '+id);},mod,mod.exports);return mod.exports;})();
// The role editor lists alerts.manage in category Monitoring.
assert.deepEqual(model.accessPermissionGroups([{id:'view',labelKey:'permission.view'},{id:'alerts.manage',labelKey:'permission.alerts.manage'}]).map(group=>[group.id,group.permissions.map(permission=>permission.id)]),[['monitoring',['view','alerts.manage']]]);checks++;
// The five extension rights are one category "Extensions" before Administration; the viewer access role reads DHCP and DNS.
const extensionGroups=model.accessPermissionGroups(['plugins.manage','dhcp.read','dhcp.manage','dns.read','dns.manage','groups.manage'].map(id=>({id,labelKey:'permission.'+id})));
assert.deepEqual(extensionGroups.map(group=>[group.id,group.permissions.map(permission=>permission.id)]),[['extensions',['plugins.manage','dhcp.read','dhcp.manage','dns.read','dns.manage']],['administration',['groups.manage']]]);checks++;
{
 const {translate}=await import('../../../lib/i18n/translate.ts');
 assert.equal(extensionGroups[0].label,'rbac.category.extensions');checks++;
 assert.deepEqual(['en','de'].map(locale=>[translate(locale,'rbac.category.extensions'),translate(locale,'permission.plugins.manage')]),[['Extensions','Manage extensions'],['Erweiterungen','Erweiterungen installieren und entfernen']],'the category Extensions and the right Manage extensions');checks++;
}

// The classic group access panel and its unused group helpers are deleted: groups change through the inventory drawers
// (tests/ui/devices/inventory-group-panel.mjs) and permissions through the Permissions view above.
assert.ok(!fs.existsSync('app/access-panel.tsx'),'app/access-panel.tsx does not exist');
assert.deepEqual(Object.keys(model).sort(),['accessPermissionGroups','accessPermissionName'],'access-model.ts keeps only the permission catalog helpers');checks+=2;

console.log(`PASS access workspace (${checks} assertions): AccessWorkspace renders each settings page by its page id with no wrapper and the no-permission page, the scoped Permissions view lists direct and inherited assignments, and the permission categories.`);
