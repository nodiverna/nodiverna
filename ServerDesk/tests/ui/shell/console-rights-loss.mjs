// Client behaviour of the console (ui/shell/console.tsx) when the viewer
// loses a right: the permissions views close, a pending removal
// confirmation, MFA retry or enroll retry is dropped and sends nothing, and
// deleting a group from the tree works end to end but only with the root group
// right. The server checks every right again; this is only about the client.
//
// The harness (tests/support/console-harness.mjs) runs RedesignConsole with
// deterministic fake hooks and inspects the props the console gives its children.
import assert from 'node:assert/strict';
import {de} from '../../support/i18n-stubs.mjs';
import {consoleHarness,isElement,nodes,ok} from '../../support/console-harness.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const stepUpRequired=()=>Response.json({error:'Bestätige die Aktion mit einem aktuellen Authenticator-Code.',code:'MFA_STEP_UP_REQUIRED'},{status:403});
const harness=({viewer,hash,data})=>consoleHarness({viewer,hash,data,base:{servers:[device],jobs:[],deviceGroups:[...groups],permissionDevices:[],customers:[],audit:[],deviceAudit:[],maintenance:null}});
// The real MfaStepUp reports the proof, then closes itself.
const verify=(dialog,proof)=>{dialog.props.onVerified(proof);dialog.props.onClose();};

const now=Date.now();
const device={id:'srv-1',name:'APP-01',createdAt:now-3600000,lastSeen:now-30000,revoked:0,management:1,snapshot:null,permissions:['view'],groupId:'g-a',groupName:'Produktion'};
const group=(id,name,parentId=null)=>({id,name,description:'',parentId,depth:parentId?1:0,customerId:'00000000-0000-4000-8000-000000000100',permissions:['view','groups.manage']});
const groups=[group('g-a','Produktion'),group('g-b','Test'),group('g-c','Kind','g-b'),group('g-d','Leer')];
const [groupA,,,groupD]=groups;
// g-d holds a device elsewhere in the fleet: deleting it asks for the step-up first (stepUpOnDelete, lib/step-up.ts).
groupD.stepUpOnDelete=true;
const admin={id:'owner',label:'owner@example.test',permissions:['*']};
const reader={...admin,permissions:[]};
const manager={id:'manager',label:'manager@example.test',permissions:['portal.roleAssignments.manage']};
const rootManager={id:'grouper',label:'grouper@example.test',permissions:['groups.manage']};
const removal={title:'APP-01 entfernen?',description:'',payload:{action:'remove-servers',ids:['srv-1'],confirm:true}};
let checks=0;

// 1. Permissions views.
{
 // The group permissions tab passes the editor only while the right lasts.
 const ui=harness({viewer:manager,hash:'#devices/group/g-a'});await ui.settle();
 assert.equal(ui.fleet().props.group,groupA,'the group route selects the group');
 ui.fleet().props.onTab('permissions');ui.render();await ui.settle();
 assert.equal(ui.fleet().props.tab,'permissions');
 const permissions=ui.fleet().props.permissions;assert.ok(isElement(permissions),'FleetView gets the permissions element');
 const editors=nodes(permissions).filter(node=>node.type==='ScopedPermissionEditor');
 assert.equal(editors.length,1);assert.deepEqual(editors[0].props.scope,{type:'group',id:'g-a'});assert.equal(editors[0].props.scopeName,'Produktion');checks+=4;
 ui.setViewer({...manager,permissions:[]});
 assert.equal(ui.fleet().props.permissions,undefined,'the very next render drops the editor');
 assert.deepEqual(ui.editors(),[],'no ScopedPermissionEditor is left in the console tree');checks+=2;
 await ui.settle();assert.equal(ui.fleet().props.permissions,undefined);assert.deepEqual(ui.editors(),[]);checks+=2;
}
{
 // The tree opens Configuration › Permissions of the device; the loss removes the editor.
 const ui=harness({viewer:manager});await ui.settle();
 ui.inventory().props.onAction('permissions',{type:'device',id:'srv-1',name:'APP-01'});ui.render();await ui.settle();
 const view=ui.device();assert.ok(view,'the device view opens');assert.equal(view.props.server.id,'srv-1');assert.deepEqual([view.props.section,view.props.detail],['configuration',{}]);
 const editors=nodes(view.props.permissions).filter(node=>node.type==='ScopedPermissionEditor');
 assert.equal(editors.length,1);assert.deepEqual(editors[0].props.scope,{type:'device',id:'srv-1'});
 assert.equal(ui.location.hash,'#device/srv-1/configuration/permissions','Configuration › Permissions has its own route');checks+=6;
 ui.setViewer({...manager,permissions:[]});
 assert.equal(ui.device().props.permissions,undefined,'DeviceView gets no editor after the loss');assert.deepEqual(ui.editors(),[]);checks+=2;
 await ui.settle();assert.equal(ui.device().props.permissions,undefined);assert.deepEqual(ui.editors(),[]);checks+=2;
 assert.equal(ui.location.hash,'#device/srv-1/monitoring/alert-rules','without the right the Configuration link falls back to Monitoring › Alert rules');assert.deepEqual([ui.device().props.section,ui.device().props.detail],['monitoring',{deviceDetail:'alert-rules'}],'and Alert rules shows');checks+=2;
}
{
 // An onAction captured before the loss changes neither view nor tab.
 const ui=harness({viewer:manager});await ui.settle();
 const onAction=ui.inventory().props.onAction;
 assert.equal(ui.inventory().props.canManagePermissions,true);
 ui.setViewer({...manager,permissions:[]});await ui.settle();
 assert.equal(ui.inventory().props.canManagePermissions,false,'the tree hides the entry');checks+=2;
 onAction('permissions',{type:'group',id:'g-a',name:'Produktion'});ui.render();await ui.settle();
 onAction('permissions',{type:'global',name:'Alle Geräte'});ui.render();await ui.settle();
 onAction('permissions',{type:'device',id:'srv-1',name:'APP-01'});ui.render();await ui.settle();
 assert.ok(ui.fleet(),'the fleet view stays');assert.equal(ui.device(),undefined,'no device view opens');
 assert.equal(ui.fleet().props.tab,'devices');assert.equal(ui.fleet().props.group,undefined,'the group filter stays at all devices');
 assert.equal(ui.location.hash,'#devices');assert.deepEqual(ui.editors(),[]);assert.equal(ui.fleet().props.permissions,undefined);checks+=7;
}
console.log('PASS: permissions views: the group tab and the device Configuration › Permissions lose their editor in the next render, a stale tree action changes nothing.');

// 2. Device removal.
{
 // The confirmation is disabled at once and cleared after the effects.
 const ui=harness({viewer:admin});await ui.settle();
 ui.fleet().props.onConfirm(removal);ui.render();
 assert.equal(ui.alert().props.open,true);assert.equal(ui.alert().props.blocked,undefined,'an admin may confirm');assert.equal(ui.alert().props.tone,'danger','a removal uses the kit danger button');checks+=3;
 const staleClick=ui.alert().props.onConfirm;
 ui.setViewer(reader);
 assert.equal(ui.alert().props.blocked,'Nur ein Owner kann Geräte entfernen.','the confirm button is blocked with its reason before any effect runs');checks++;
 await ui.settle();
 assert.equal(ui.alert().props.open,false,'the removal confirmation is cleared');checks++;
 staleClick();ui.render();await ui.settle();
 assert.deepEqual(ui.posts,[],'the stale Bestätigen sends nothing');assert.equal(ui.mfa().props.open,false,'and opens no MFA prompt');
 assert.deepEqual(ui.errors(),['error:Dir fehlt die Berechtigung, Geräte zu entfernen.'],'the existing toast says why');checks+=3;
}
{
 // A confirmation that removes nothing stays open after the same loss.
 const ui=harness({viewer:admin});await ui.settle();
 ui.fleet().props.onConfirm({title:'Wartenden Auftrag abbrechen?',description:'',confirmLabel:'Auftrag abbrechen',payload:{action:'cancel-job',id:'job-1'}});ui.render();
 ui.setViewer(reader);await ui.settle();
 assert.equal(ui.alert().props.open,true,'cancel-job stays open');assert.equal(ui.alert().props.blocked,undefined);assert.equal(ui.alert().props.confirmLabel,'Auftrag abbrechen','the confirmation keeps its own verb');assert.equal(ui.alert().props.tone,'default');checks+=4;
}
for(const cleanedUp of [false,true]){
 // The step-up opens before anything is sent; a proof after the loss sends nothing.
 const ui=harness({viewer:admin});await ui.settle();
 ui.fleet().props.onConfirm(removal);ui.render();
 ui.alert().props.onConfirm();ui.render();
 assert.equal(ui.mfa().props.open,true,'confirming a removal opens MfaStepUp');assert.equal(ui.alert().props.open,false);assert.deepEqual(ui.posts,[],'nothing is sent before the proof');checks+=3;
 const stale=ui.mfa();
 ui.setViewer(reader);
 if(cleanedUp){await ui.settle();assert.equal(ui.mfa().props.open,false,'MfaStepUp closes after the loss');checks++;}
 verify(stale,{managementToken:'stale'});ui.render();await ui.settle();
 assert.deepEqual(ui.posts,[],`a stale proof sends nothing (${cleanedUp?'after':'before'} the cleanup effect)`);assert.equal(ui.mfa().props.open,false);checks+=2;
}
{
 // The proof is on its way when the right goes; MFA_STEP_UP_REQUIRED then reopens nothing.
 const ui=harness({viewer:admin});await ui.settle();
 const answer=deferred();ui.state.reply=()=>answer.promise;
 ui.fleet().props.onConfirm(removal);ui.render();ui.alert().props.onConfirm();ui.render();
 verify(ui.mfa(),{managementToken:'proof'});ui.render();await ui.settle();
 assert.deepEqual(ui.posts,[{url:'/api/console',body:{action:'remove-servers',ids:['srv-1'],confirm:true,managementToken:'proof'}}],'the proof is sent once');checks++;
 ui.setViewer(reader);await ui.settle();
 answer.resolve(stepUpRequired());await ui.settle();
 assert.equal(ui.mfa().props.open,false,'MfaStepUp stays closed');assert.deepEqual(ui.errors(),[],'no error toast');checks+=2;
 verify(ui.mfa(),{managementToken:'later'});ui.render();await ui.settle();
 assert.equal(ui.posts.length,1,'no retry was stored');checks++;
}
for(const cleanedUp of [false,true]){
 // Enroll's step-up retry is dropped with the admin role (the form of the page Add device sends through the console).
 const ui=harness({viewer:admin,hash:'#devices/add'});await ui.settle();
 ui.state.reply=()=>stepUpRequired();
 ui.find('AddDevicePage').props.onEnroll({name:'SRV-NEU',mode:'ReadOnly',groupId:''},()=>{});ui.render();await ui.settle();
 assert.equal(ui.posts.length,1);assert.equal(ui.posts[0].body.action,'enroll');assert.equal(ui.mfa().props.open,true,'MFA_STEP_UP_REQUIRED opens MfaStepUp');assert.deepEqual(ui.errors(),[]);checks+=4;
 const stale=ui.mfa();ui.state.reply=ok;
 ui.setViewer(reader);
 if(cleanedUp){await ui.settle();assert.equal(ui.mfa().props.open,false,'the dialog closes after the loss');checks++;}
 verify(stale,{managementToken:'late'});ui.render();await ui.settle();
 assert.equal(ui.posts.length,1,`no second enroll POST (${cleanedUp?'after':'before'} the cleanup effect)`);assert.equal(ui.mfa().props.open,false);checks+=2;
}
console.log('PASS: device removal: the confirm button is blocked at once and the dialog cleared after the effects, stale proofs and a late MFA_STEP_UP_REQUIRED send and reopen nothing, enroll drops its retry.');

// 3. Group deletion from the tree.
{
 // Losing the root group right closes the drawer for good; a stale onDelete sends nothing.
 const ui=harness({viewer:rootManager});await ui.settle();
 ui.inventory().props.onAction('delete-group',{type:'group',id:'g-a',name:'Produktion'});ui.render();
 assert.equal(ui.drawer().props.group,groupA,'the drawer opens for a root group manager');checks++;
 const staleDelete=ui.drawer().props.onDelete;
 ui.setViewer({...rootManager,permissions:[]});
 assert.equal(ui.drawer().props.group,null,'the very next render closes the drawer');checks++;
 await ui.settle();
 ui.setViewer(rootManager);await ui.settle();
 assert.equal(ui.drawer().props.group,null,'the drawer stays closed when the right comes back');checks++;
 ui.setViewer({...rootManager,permissions:[]});await ui.settle();
 staleDelete();ui.render();await ui.settle();
 assert.deepEqual(ui.posts,[],'a stale onDelete sends nothing');assert.equal(ui.accessMfa().props.open,false,'and opens no MFA prompt');checks+=2;
 ui.setViewer(rootManager);await ui.settle();
 ui.inventory().props.onAction('delete-group',{type:'group',id:'g-a',name:'Produktion'});ui.render();
 assert.equal(ui.drawer().props.group,groupA,'a new delete action opens it again');checks++;
}
{
 // Demo mode closes the drawer, and a stale onDelete stays silent there.
 const ui=harness({viewer:admin});await ui.settle();
 ui.inventory().props.onAction('delete-group',{type:'group',id:'g-d',name:'Leer'});ui.render();
 assert.equal(ui.drawer().props.group,groupD);const staleDelete=ui.drawer().props.onDelete;
 ui.fleet().props.onDemo();ui.render();
 assert.equal(ui.drawer().props.group,null,'demo mode closes the drawer');checks+=2;
 await ui.settle();staleDelete();ui.render();await ui.settle();
 assert.deepEqual(ui.posts,[]);assert.equal(ui.accessMfa().props.open,false);checks+=2;
}
{
 // Tree → drawer → step-up → /api/access, and the selection falls back to all devices.
 const ui=harness({viewer:admin,hash:'#devices/group/g-d'});await ui.settle();
 assert.equal(ui.fleet().props.group,groupD);
 ui.inventory().props.onAction('delete-group',{type:'group',id:'g-d',name:'Falscher Name'});ui.render();
 assert.equal(ui.drawer().props.group,groupD,'the drawer gets the catalog group');assert.equal(ui.drawer().props.group.name,'Leer','the name comes from deviceGroups');checks+=3;
 ui.drawer().props.onDelete();ui.render();await ui.settle();
 assert.equal(ui.accessMfa().props.open,true,'deleting asks for the access step-up');assert.deepEqual(ui.posts,[],'nothing is sent yet');checks+=2;
 verify(ui.accessMfa(),{managementToken:'proof'});ui.render();await ui.settle();
 assert.deepEqual(ui.posts,[{url:'/api/access',body:{action:'delete-group',id:'g-d',confirm:true,managementToken:'proof'}}],'exactly one POST');
 assert.equal(ui.drawer().props.group,null,'the drawer closes');assert.deepEqual(ui.refreshes,[[true]],'the console refreshes');
 assert.equal(ui.fleet().props.group,undefined,'the deleted group is no longer selected');assert.equal(ui.location.hash,'#devices');
 assert.deepEqual(ui.toasts,[de('console.groupDeleted')]);checks+=6;
}
{
 // An empty group (stepUpOnDelete false) deletes at once, without the MFA dialog and without a token.
 groupD.stepUpOnDelete=false;
 try{
  const ui=harness({viewer:admin,hash:'#devices/group/g-d'});await ui.settle();
  ui.inventory().props.onAction('delete-group',{type:'group',id:'g-d',name:'Leer'});ui.render();
  ui.drawer().props.onDelete();ui.render();await ui.settle();
  assert.equal(ui.accessMfa().props.open,false,'an empty group opens no MFA dialog');
  assert.deepEqual(ui.posts,[{url:'/api/access',body:{action:'delete-group',id:'g-d',confirm:true}}],'exactly one POST without a token');
  assert.deepEqual(ui.toasts,[de('console.groupDeleted')]);checks+=3;
 }finally{groupD.stepUpOnDelete=true;}
}
{
 // Another group selected in the meantime stays selected.
 const ui=harness({viewer:admin,hash:'#devices/group/g-d'});await ui.settle();
 ui.inventory().props.onAction('delete-group',{type:'group',id:'g-d',name:'Leer'});ui.render();
 ui.drawer().props.onDelete();ui.render();await ui.settle();
 ui.inventory().props.onGroup('g-a');ui.render();await ui.settle();
 verify(ui.accessMfa(),{managementToken:'proof'});ui.render();await ui.settle();
 assert.equal(ui.posts.length,1);assert.equal(ui.fleet().props.group,groupA,'the other group stays selected');assert.equal(ui.location.hash,'#devices/group/g-a');checks+=3;
}
{
 // No drawer for child groups, without the root right, in demo mode or for an unknown id.
 const ui=harness({viewer:admin});await ui.settle();
 ui.inventory().props.onAction('delete-group',{type:'group',id:'g-b',name:'Test'});ui.render();await ui.settle();
 assert.equal(ui.drawer().props.group,null,'a group with child groups');
 ui.inventory().props.onAction('delete-group',{type:'group',id:'missing',name:'Weg'});ui.render();await ui.settle();
 assert.equal(ui.drawer().props.group,null,'an id that is not in the catalog');checks+=2;
 const onAction=ui.inventory().props.onAction;
 ui.fleet().props.onDemo();ui.render();await ui.settle();
 assert.equal(ui.inventory().props.onAction,undefined,'the tree has no actions in demo mode');
 onAction('delete-group',{type:'group',id:'g-a',name:'Produktion'});ui.render();await ui.settle();
 assert.equal(ui.drawer().props.group,null,'demo mode');checks+=2;
 const operator=harness({viewer:{id:'op',label:'op@example.test',permissions:[],canManageDeviceGroups:true}});await operator.settle();
 operator.inventory().props.onAction('delete-group',{type:'group',id:'g-a',name:'Produktion'});operator.render();await operator.settle();
 assert.equal(operator.drawer().props.group,null,'groups.manage on the group is not the root group right');checks++;
 // A group that disappears from deviceGroups closes its open drawer.
 const vanish=harness({viewer:admin});await vanish.settle();
 vanish.inventory().props.onAction('delete-group',{type:'group',id:'g-a',name:'Produktion'});vanish.render();
 assert.equal(vanish.drawer().props.group,groupA);
 vanish.setData({deviceGroups:groups.filter(item=>item.id!=='g-a')});
 assert.equal(vanish.drawer().props.group,null,'the vanished group closes the drawer');checks+=2;
 assert.deepEqual([...ui.posts,...operator.posts,...vanish.posts],[]);checks++;
}
console.log('PASS: group deletion: the drawer follows the root group right and demo mode, the tree path deletes through the step-up once, refusals open no drawer.');
console.log(`${checks} console rights loss checks passed.`);
