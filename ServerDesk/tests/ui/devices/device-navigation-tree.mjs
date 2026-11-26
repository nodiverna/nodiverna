// The navigator's device and group model (ui/devices/fleet/inventory-navigation.ts), which ui/devices/fleet/inventory-tree.tsx and the
// console read: group folders sorted by name with their device counts (descendants once), the API catalog as the owner
// of every folder, no invented group for an ungrouped device, and permission-only targets without monitoring fields.
// The tree itself (keyboard, menus, customer folders) is tested in tests/ui/devices/inventory-tree-customers.mjs.
import '../../support/register.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const {navigationDeviceGroups:groups,navigationDevices:devicesOf}=await import('../../../ui/devices/fleet/inventory-navigation.ts');
let checks=0;

const devices=[{id:'a10',name:'APP-10',groupId:'prod',groupName:'Produktion'},{id:'a2',name:'APP-2',groupId:'prod',groupName:'Produktion'},{id:'b',name:'TEST-01',groupId:'test',groupName:'Test'},{id:'c',name:'LOOSE-01',groupId:null}];
assert.deepEqual(groups(devices).map(group=>group.id),['prod','test'],'folders sort by name');
assert.deepEqual(groups(devices)[0].servers.map(server=>server.name),['APP-2','APP-10'],'devices sort by name with numbers in order');
assert.ok(!groups(devices).some(group=>group.servers.some(server=>server.id==='c')),'an ungrouped device belongs to no invented group');
checks+=3;
// Without a group name, a folder takes the catalog name of a device group in the requested language.
assert.equal(groups([{id:'x',name:'X',groupId:'g'}],undefined,'en')[0].name,'Device group');
assert.equal(groups([{id:'x',name:'X',groupId:'g'}],undefined,'de')[0].name,'Gerätegruppe');checks+=2;

// Real API group references include ancestors plus each direct membership.
const hierarchy=[{id:'root',name:'Produktion',parentId:null,depth:0,direct:false},{id:'g1',name:'Europa',parentId:'root',depth:1,direct:false},{id:'g2',name:'Deutschland',parentId:'g1',depth:2,direct:false},{id:'g3',name:'Berlin',parentId:'g2',depth:3,direct:false},{id:'g4',name:'Web',parentId:'g3',depth:4,direct:true}];
const grouped=[{id:'deep',name:'WEB-01',groupId:'g4',groupName:'Web',groups:[...hierarchy,{id:'backup',name:'Sicherung',parentId:null,depth:0,direct:true}]},{id:'shared',name:'DB-01',groupId:'g2',groupName:'Deutschland',groups:[{...hierarchy[0],direct:true},hierarchy[1],{...hierarchy[2],direct:true}]}];
const treeGroups=groups(grouped),find=id=>treeGroups.find(group=>group.id===id);
assert.equal(find('root').servers.length,2,'a root count includes descendant devices without duplicated memberships');
assert.deepEqual(find('root').directServers.map(device=>device.id),['shared']);
assert.equal(find('g2').servers.length,2);
assert.equal(find('g2').directServers.length,1);
assert.deepEqual(['root','g1','g2','g3','g4'].map(id=>find(id).depth),[0,1,2,3,4],'depth and parents come from the references');
assert.deepEqual(find('backup').directServers.map(device=>device.id),['deep'],'a second direct membership lists the device there too');
checks+=6;

// The API catalog, rather than the current device list, owns every real folder.
const catalog=[{id:'empty',name:'Leere Gruppe',parentId:null,depth:0,permissions:['view','groups.manage']},{id:'child-empty',name:'Leere Untergruppe',parentId:'empty',depth:1,permissions:['view','groups.manage']},{id:'prod',name:'Produktion',parentId:null,depth:0,permissions:['view']},{id:'context',name:'Kontext',parentId:null,depth:0,permissions:[]}];
const fromCatalog=groups(devices,catalog);
assert.deepEqual(fromCatalog.map(group=>group.id),['context','empty','child-empty','prod'],'every catalog folder, sorted by name');
assert.equal(fromCatalog.find(group=>group.id==='empty').servers.length,0,'an empty catalog folder stays');
assert.equal(fromCatalog.find(group=>group.id==='test'),undefined,'a stale device reference cannot invent a group missing from the catalog');
assert.deepEqual(fromCatalog.find(group=>group.id==='empty').permissions,['view','groups.manage'],'the folder keeps its catalog permissions');
assert.equal(groups([],catalog).length,4,'every authorized empty catalog entry survives without any device');
assert.equal(groups([],[]).length,0,'a fresh deployment has no default or synthetic group');
checks+=6;

// IAM administrators can assign a device without receiving monitoring payloads.
const monitored={...devices[0],snapshot:{hostname:'PRIVATE'},lastSeen:12345};
const metadata=[{id:'a10',name:'IGNORE DUPLICATE',groupId:'empty'},{id:'metadata',name:'IAM-01',groupId:'empty',groupName:'Leere Gruppe',snapshot:{hostname:'MUST NOT COPY'},lastSeen:54321},{id:'metadata-root',name:'IAM-02',groupId:null},{id:'metadata-root',name:'DUPLICATE',groupId:'empty'}];
const merged=devicesOf([monitored],metadata,true);
assert.equal(merged.length,3,'duplicates are dropped');
assert.equal(merged[0],monitored,'a real visible device keeps its identity');
assert.equal(merged.find(device=>device.id==='metadata').permissionOnly,true);
assert.equal(Object.hasOwn(merged.find(device=>device.id==='metadata'),'snapshot'),false);
assert.equal(Object.hasOwn(merged.find(device=>device.id==='metadata'),'lastSeen'),false,'permission metadata is projected without monitoring fields');
assert.deepEqual(devicesOf([monitored],metadata,false),[monitored],'without the permission right no metadata target is added');
assert.equal(groups(merged,catalog).find(group=>group.id==='empty').servers.length,1,'a permission target counts in its folder');
checks+=7;

// The module is pure: no React, no stylesheet; the old classic tree is gone.
const source=fs.readFileSync('ui/devices/fleet/inventory-navigation.ts','utf8');
assert.doesNotMatch(source,/from 'react'|\.css'|lucide-react/,'ui/devices/fleet/inventory-navigation.ts is pure');
assert.ok(!fs.existsSync('app/device-navigation-tree.tsx')&&!fs.existsSync('app/device-navigation-tree.css'),'the classic DeviceNavigationTree is deleted');
checks+=2;
console.log(`PASS device navigation model (${checks} assertions): sorted folders, descendant counts, the catalog as folder owner and metadata-only IAM targets.`);
