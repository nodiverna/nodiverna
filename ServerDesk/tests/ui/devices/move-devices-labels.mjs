// The move labels of the scope view (review §2.6) and the Move drawer description (what the target group gives the devices): the group drawer "Move devices to “{name}”" with the submit
// "Move" and a description without "Agents", the tree entry and the header button "Move devices here…", the row
// menu entry and the bulk bar button "Move to group…". The drawer runs on hook cells
// (tests/support/panel-harness.mjs) and renders its open Drawer in the markup. No browser, no server.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const en=key=>translate('en',key);

// ---- The copy in both languages ----
check([en('groups.assign.title').replace('{name}','Berlin'),en('groups.move.submit'),en('console.moveDevicesHere'),en('groups.assign.submit')],['Move devices to “Berlin”','Move','Move devices here…','Move to group…'],'the English labels');
check([de('groups.assign.title',{name:'Berlin'}),de('groups.move.submit'),de('console.moveDevicesHere'),de('groups.assign.submit')],['Geräte nach „Berlin“ verschieben','Verschieben','Geräte hierher verschieben…','In Gruppe verschieben…'],'the German labels');
ok(!/Agents/.test(en('groups.assign.description'))&&!/Agents/.test(de('groups.assign.description')),'the drawer description no longer mentions Agents');
check(en('groups.assign.description'),'The devices you select leave their current group. To add a new device, use Add device.','the new description');

// ---- The group drawer: title, description and the submit "Move" ----
{
 const harness=panelHarness({hooked:['ui/devices/fleet/groups.tsx'],stubs:{'@/ui/session/mfa-step-up':{MfaStepUp:()=>null}}});
 const {AssignDevicesDrawer}=harness.load('ui/devices/fleet/groups.tsx');
 const group={id:'g1',name:'Berlin',description:'',parentId:null,depth:0,deviceCount:0,permissions:['groups.manage']};
 const servers=[{id:'a',name:'SRV-A',groupId:null,groupName:null,revoked:0},{id:'b',name:'SRV-B',groupId:'g2',groupName:'Hamburg',revoked:0}];
 const props={group,servers,busy:false,onClose:()=>{},onAssign:()=>{}};
 harness.reset();const html=harness.html(AssignDevicesDrawer,props);
 ok(html.includes('Geräte nach „Berlin“ verschieben'),'the drawer title "Geräte nach „Berlin“ verschieben"');
 ok(text(html).includes(de('groups.assign.description')),'its description');
 const tree=harness.tree(AssignDevicesDrawer,props);
 const submit=harness.walk(tree).find(node=>node.props?.variant==='primary');
 check(harness.text(submit).trim(),de('groups.move.submit'),'the submit is "Verschieben"');
 check(submit.props.blocked,de('groups.assign.pickOne'),'blocked until a device is chosen');
}

// ---- The Move drawer: its description says what the target group gives the devices ----
{
 const harness=panelHarness({hooked:['ui/devices/fleet/groups.tsx'],stubs:{'@/ui/session/mfa-step-up':{MfaStepUp:()=>null}}});
 const {MoveDevicesDrawer}=harness.load('ui/devices/fleet/groups.tsx');
 const groups=[{id:'g1',name:'Berlin',description:'',parentId:null,depth:0,deviceCount:0,permissions:['groups.manage']}];
 const devices=[{id:'a',name:'SRV-A',groupId:null,groupName:null,revoked:0}];
 const viewer={id:'u1',role:'owner',permissions:['groups.manage']};
 harness.reset();const html=harness.html(MoveDevicesDrawer,{open:true,devices,groups,viewer,busy:false,onClose:()=>{},onMove:()=>{}});
 ok(text(html).includes(de('groups.move.description')),'the Move drawer shows groups.move.description');
 check(en('groups.move.description'),'A device can be in only one group. After the move, the devices get the permissions, tags, alert rules and notification rules of the target group.','the new English description');
 ok(!/apply at once/i.test(en('groups.move.description'))&&!/gelten sofort/.test(text(html)),'the drawer no longer says "apply at once"');
}

// ---- Where each label is used ----
{
 const fleet=readFileSync('ui/devices/fleet/fleet.tsx','utf8'),tree=readFileSync('ui/devices/fleet/inventory-tree.tsx','utf8'),consoleSource=readFileSync('ui/shell/console.tsx','utf8');
 ok(/\{id:'move',label:t\('groups\.assign\.submit'\)/.test(fleet),'the fleet row menu: "Move to group…"');
 ok(/onClick=\{\(\)=>onMove\(selected\.map\(server=>server\.id\)\)\}>\{t\('groups\.assign\.submit'\)\}<\/Btn>/.test(fleet),'the bulk bar: "Move to group…"');
 ok(/\{id:'manage-group',label:t\('console\.moveDevicesHere'\)/.test(tree),'the tree entry manage-group: "Move devices here…"');
 ok(/t\('console\.moveDevicesHere'\)/.test(consoleSource)&&!/assignDevices/.test(consoleSource+fleet+tree),'the header button; "Assign devices" is gone');
 check([en('tree.assignDevices'),en('console.assignDevices')],['tree.assignDevices','console.assignDevices'],'the old keys left both catalogs');
}

console.log(`PASS move devices labels (${checks} checks): the drawer title, description and submit, the Move drawer description, the tree entry and header button "Move devices here…", the row menu and bulk bar "Move to group…", and the removed "Assign devices" keys.`);
