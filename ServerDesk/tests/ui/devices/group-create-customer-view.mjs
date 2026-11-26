// The customer field when the new console creates a root group: the
// real GroupCreateDrawer/GroupCreateForm with deterministic hooks. Then the kit
// form of the drawer: Field-bound Selects (SSR with the real kit), the drawer's
// dirty from the form state and DrawerCancel. Last, the GroupDeleteDrawer footer: DrawerCancel without a
// native disabled, and its close clears the typed name. No server or browser is touched.
import {mock} from '../../support/register.mjs';
import * as radix from 'radix-ui';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';

let checks=0;
const firstCustomer='00000000-0000-4000-8000-000000000100',alpha='6a3c1f0e-8d2b-4c55-9e1a-2f4b7c9d0e11',beta='0b7e5d2a-4f61-4a8c-b3d9-7e2c1a5f6d22';
const jsx=(type,props,key)=>({type,props:props??{},key});
const source=filename=>ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;

function harness(props){
 const cells=[],created=[];let cursor=0,form,lastDrawer;
 const hooks={
  useState(initial){const index=cursor++;cells[index]??={value:typeof initial==='function'?initial():initial};return [cells[index].value,value=>{cells[index].value=typeof value==='function'?value(cells[index].value):value;}];},
  useRef(initial){const index=cursor++;cells[index]??={value:{current:initial}};return cells[index].value;},
  useMemo(fn){return fn();},
 };
 const cache=new Map();
 function load(filename){
  const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;
  const mod={exports:{}};cache.set(absolute,mod);
  const require=id=>i18nRequire(id)??(id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({}, {get:(_target,key)=>String(key)}):id==='@/ui/kit/analysis-tab'?{AnalysisTab:'AnalysisTab'}:id==='@/ui/kit/name-confirm-drawer'?load('ui/kit/name-confirm-drawer.tsx'):id==='sonner'?{toast:{success(){},error(){}}}:id==='@/ui/session/mfa-step-up'?{MfaStepUp:'MfaStepUp'}:id==='@/ui/base/api'?{api:async()=>({}),message:String}:id==='@/ui/session/step-up-retry'?{useStepUp:()=>({run:async()=>null,busy:false,dialog:{}})}:id==='@/ui/base/access-capabilities'?{canManageDeviceGroups:()=>true}:id==='@/ui/kit/kit'?{Btn:'Btn',Card:'Card',DangerZone:'DangerZone',Drawer:'Drawer',DrawerCancel:'DrawerCancel',Empty:'Empty',PickCheckRow:'PickCheckRow',PickList:'PickList',PickRow:'PickRow',cx:(...names)=>names.filter(Boolean).join(' ')}:id==='@/ui/kit/field'?{Field:'Field',FormActions:'FormActions',Select:'Select'}:id==='@/ui/devices/fleet/customer-choice'?load('ui/devices/fleet/customer-choice.ts'):id==='@/lib/default-customer'?load('lib/default-customer.ts'):id==='@/lib/errors/codes'?load('lib/errors/codes.ts'):id==='@/lib/step-up'?load('lib/step-up.ts'):id==='@/ui/devices/fleet/groups-model'?load('ui/devices/fleet/groups-model.ts'):(()=>{throw Error('Unexpected import '+id);})());
  new Function('require','module','exports',source(absolute))(require,mod,mod.exports);return mod.exports;
 }
 const groupsModule=load('ui/devices/fleet/groups.tsx'),{GroupCreateDrawer}=groupsModule;
 const nodes=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(child=>nodes(child))];
 const text=node=>typeof node==='string'||typeof node==='number'?String(node):!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(text).join('');
 function render(){
  cursor=0;
  const drawer=GroupCreateDrawer({open:true,busy:false,onClose(){},onCreate:input=>created.push(input),...props});lastDrawer=drawer;
  const child=[drawer.props.children].flat(Infinity).find(node=>node&&typeof node.type==='function');
  form=child.type(child.props);
 }
 // The kit Field: its label prop names it, its one child is the control (input, Select, textarea).
 const field=label=>nodes(form).find(node=>node.type==='Field'&&text(node.props.label)===label);
 const control=(label,type)=>nodes(field(label)).find(node=>node.type===type);
 render();
 return {created,render,field,control,text,nodes,get form(){return form;},get drawer(){return lastDrawer;},
  /** Renders another component of groups.tsx on its own hook cells (from cell 1000). */
  renderOther(name,props){cursor=1000;const element=groupsModule[name](props);return typeof element?.type==='function'?element.type(element.props):element;},
  change(label,type,value){control(label,type).props.onChange({target:{value}});render();},
  submit(){form.props.onSubmit({preventDefault(){}});render();}};
}
const groups=[{id:'7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e44',name:'Produktion',description:'',parentId:null,depth:0,permissions:['groups.manage']}];

// One customer: no field, and the request is identical to before.
let ui=harness({parent:null,groups,customers:[{id:firstCustomer,name:'Standardkunde'}]});
assert.equal(ui.field('Kunde'),undefined);
ui.change('Name','input','Neu');ui.submit();
assert.deepEqual(ui.created,[{name:'Neu',description:'',parentId:null}]);
assert.equal(Object.hasOwn(ui.created[0],'customerId'),false);checks+=3;
// No list at all (older responses) behaves the same.
ui=harness({parent:null,groups});
assert.equal(ui.field('Kunde'),undefined);ui.change('Name','input','Neu');ui.submit();assert.deepEqual(ui.created,[{name:'Neu',description:'',parentId:null}]);checks+=2;

// Two customers: the field is preselected with the first customer, even when it is not listed first.
ui=harness({parent:null,groups,customers:[{id:alpha,name:'Alpha GmbH'},{id:firstCustomer,name:'Standardkunde'}]});
assert.ok(ui.field('Kunde'),'the customer field');
assert.equal(ui.control('Kunde','Select').props.value,firstCustomer);
assert.deepEqual(ui.nodes(ui.control('Kunde','Select')).filter(node=>node.type==='option').map(node=>[node.props.value,ui.text(node)]),[[alpha,'Alpha GmbH'],[firstCustomer,'Standardkunde']]);
assert.equal(ui.field('Kunde').props.hint,'Die Gruppe und alle Geräte darin gehören zu diesem Kunden.');checks+=4;
ui.change('Name','input','Kunde A');ui.submit();
assert.deepEqual(ui.created.at(-1),{name:'Kunde A',description:'',parentId:null,customerId:firstCustomer});
ui.change('Kunde','Select',alpha);
assert.equal(ui.control('Kunde','Select').props.value,alpha);ui.submit();
assert.deepEqual(ui.created.at(-1),{name:'Kunde A',description:'',parentId:null,customerId:alpha});checks+=3;
// Choosing a parent group hides the field: a subgroup keeps its parent's customer.
ui.change('Übergeordnete Gruppe','Select',groups[0].id);
assert.equal(ui.field('Kunde'),undefined);ui.submit();
assert.deepEqual(ui.created.at(-1),{name:'Kunde A',description:'',parentId:groups[0].id});checks+=2;

// Without the first customer in the list the first entry is preselected.
ui=harness({parent:null,groups,customers:[{id:beta,name:'Beta AG'},{id:alpha,name:'Alpha GmbH'}]});
assert.equal(ui.control('Kunde','Select').props.value,beta);checks++;

// A subgroup opened from its parent never shows the field.
ui=harness({parent:groups[0],groups,customers:[{id:alpha,name:'Alpha GmbH'},{id:firstCustomer,name:'Standardkunde'}]});
assert.equal(ui.field('Kunde'),undefined);ui.change('Name','input','Unter');ui.submit();
assert.deepEqual(ui.created,[{name:'Unter',description:'',parentId:groups[0].id}]);checks+=2;

// A preset customer (customer folder action) is selected initially and sent as customerId.
ui=harness({parent:null,groups,customers:[{id:alpha,name:'Alpha GmbH'},{id:firstCustomer,name:'Standardkunde'}],customerId:alpha});
assert.equal(ui.control('Kunde','Select').props.value,alpha,'the preset customer');
ui.change('Name','input','Alpha Root');ui.submit();
assert.deepEqual(ui.created,[{name:'Alpha Root',description:'',parentId:null,customerId:alpha}]);
ui.change('Kunde','Select',firstCustomer);ui.submit();
assert.deepEqual(ui.created.at(-1),{name:'Alpha Root',description:'',parentId:null,customerId:firstCustomer},'the preset can still be changed');checks+=3;
// An unknown preset falls back like rootGroupCustomerId: the default customer when listed.
ui=harness({parent:null,groups,customers:[{id:alpha,name:'Alpha GmbH'},{id:firstCustomer,name:'Standardkunde'}],customerId:beta});
assert.equal(ui.control('Kunde','Select').props.value,firstCustomer);
ui.change('Name','input','Fallback');ui.submit();
assert.deepEqual(ui.created,[{name:'Fallback',description:'',parentId:null,customerId:firstCustomer}]);checks+=2;
// The form is keyed by the preset, so a new preset starts a fresh form.
{const groupsSource=fs.readFileSync('ui/devices/fleet/groups.tsx','utf8');assert.match(groupsSource,/formKey=open\?\(parent\?\.id\?\?'root'\)\+':'\+\(customerId\?\?''\):''/);assert.match(groupsSource,/<GroupCreateForm key=\{formKey\}/);checks++;}

// The console passes the customers from GET /api/console to the drawer.
assert.match(fs.readFileSync('ui/shell/console.tsx','utf8'),/<GroupCreateDrawer (?:[^\n]*\n){0,2}[^\n]*customers=\{data\?\.customers\}/);checks++;

// ---- SSR with the real kit: the labels are bound to the Selects, the name error after the first submit ----
{
 mock('radix-ui',{...radix,Dialog:{...radix.Dialog,Portal:({children})=>children}});
 const {GroupCreateDrawer}=await import('../../../ui/devices/fleet/groups.tsx');
 const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
 const html=renderToStaticMarkup(React.createElement(LocaleProvider,{locale:'en'},React.createElement(GroupCreateDrawer,{open:true,parent:null,groups,customers:[{id:alpha,name:'Alpha GmbH'},{id:firstCustomer,name:'Standardkunde'}],busy:false,onClose(){},onCreate(){}})));
 const bound=label=>{const match=html.match(new RegExp(`<label class="sdx-field-label" for="([^"]+)">${label}</label>(<select[^>]*>)`));return !!match&&match[2].includes(`id="${match[1]}"`)&&match[2].includes('class="sdx-select"');};
 assert.ok(bound('Parent group')&&bound('Customer'),'Parent group and Customer: kit Selects bound to their Field labels');
 assert.match(html,/<label class="sdx-field-label" for="([^"]+)">Name<\/label><input[^>]*id="\1"/,'the name input is Field-bound');
 assert.match(html,/<label class="sdx-field-label" for="[^"]+">Description <small>optional<\/small><\/label><textarea/,'the Description label keeps "optional"');
 assert.match(html,/aria-describedby="[^"]+-hint"[^>]*class="sdx-select"|class="sdx-select"[^>]*aria-describedby="[^"]+-hint"/,'the hint describes the select');
 assert.doesNotMatch(html,/<label class="sdx-field"><span>/,'no raw label.sdx-field');
 assert.match(html,/<footer class="sdx-drawer-foot"><button type="button" class="sdx-btn sdx-btn-secondary"[^>]*><span>Cancel<\/span><\/button>/,'DrawerCancel: a secondary Cancel, usable');checks+=6;
}

// ---- The drawer's dirty comes from the form state; the footer Cancel is DrawerCancel ----
{
 const {groupCreateDirty}=await import('../../../ui/devices/fleet/groups.tsx');
 const initial={parentId:'',customerId:firstCustomer},clean={name:'',description:'',...initial};
 assert.deepEqual([groupCreateDirty(clean,initial),groupCreateDirty({...clean,name:'N'},initial),groupCreateDirty({...clean,description:'D'},initial),groupCreateDirty({...clean,parentId:groups[0].id},initial),groupCreateDirty({...clean,customerId:alpha},initial)],[false,true,true,true,true],'dirty: a name, a description, another parent or another customer');checks++;
 ui=harness({parent:null,groups,customers:[{id:alpha,name:'Alpha GmbH'},{id:firstCustomer,name:'Standardkunde'}],customerId:firstCustomer});
 assert.equal(ui.drawer.props.dirty,false,'a fresh form is clean');
 ui.change('Name','input','N');assert.equal(ui.drawer.props.dirty,true,'a typed name makes the drawer dirty');
 ui.change('Name','input','');assert.equal(ui.drawer.props.dirty,false,'an emptied name is clean again');
 ui.change('Kunde','Select',alpha);assert.equal(ui.drawer.props.dirty,true,'another customer is dirty');
 const description=ui.text(ui.nodes(ui.form).find(node=>node.type==='Field'&&ui.text(node.props.label).startsWith('Beschreibung')).props.label);
 assert.equal(description,'Beschreibung optional','the Description label keeps its "optional" marker');
 ui.change('Kunde','Select',firstCustomer);ui.change(description,'textarea','x');assert.equal(ui.drawer.props.dirty,true,'a description is dirty');checks+=6;
 const footer=[ui.drawer.props.footer.props.children].flat();
 assert.deepEqual(footer.map(node=>node.type),['DrawerCancel','Btn'],'the footer: DrawerCancel, then the primary submit');checks++;
}

// ---- GroupDeleteDrawer: Cancel is DrawerCancel, usable while the deletion runs, and closes through the drawer's close ----
{
 ui=harness({parent:null,groups});
 const group={id:'g-del',name:'Hamburg',description:'',parentId:null,depth:0,deviceCount:0};
 const closes=[];
 const props={group,busy:true,onClose:()=>closes.push('close'),onDelete(){}};
 let drawer=ui.renderOther('GroupDeleteDrawer',props);
 const footer=[drawer.props.footer.props.children].flat();
 assert.deepEqual(footer.map(node=>node.type),['DrawerCancel','Btn'],'the delete footer: DrawerCancel, then the danger Btn');
 assert.deepEqual(footer[0].props,{},'DrawerCancel has no disabled prop: usable while the deletion runs');checks+=2;
 const input=()=>ui.nodes(drawer).find(node=>node.type==='input');
 input().props.onChange({target:{value:'Hamb'}});drawer=ui.renderOther('GroupDeleteDrawer',props);
 assert.equal(input().props.value,'Hamb','the typed name is kept while the drawer is open');
 // DrawerCancel calls the drawer's guarded close (kit-confirm-dialog.mjs), which is this onClose.
 drawer.props.onClose();drawer=ui.renderOther('GroupDeleteDrawer',props);
 assert.deepEqual([closes,input().props.value],[['close'],''],'the drawer close tells the caller and clears the typed name');checks+=2;
 const groupsSource=fs.readFileSync('ui/devices/fleet/groups.tsx','utf8');
 // The drawer itself is the kit NameConfirmDrawer (ui/kit/name-confirm-drawer.tsx), which holds the footer.
 const deleteSource=fs.readFileSync('ui/kit/name-confirm-drawer.tsx','utf8');
 assert.ok(groupsSource.includes('<NameConfirmDrawer ')&&deleteSource.includes('<DrawerCancel/>')&&!/<Btn disabled=\{busy\}/.test(groupsSource)&&!/<Btn[^>]*disabled=[^>]*>\{t\('common\.cancel'\)\}/.test(groupsSource),'groups.tsx has no Cancel Btn with a native disabled');checks++;
}

console.log(`${checks} group create customer checks passed.`);
