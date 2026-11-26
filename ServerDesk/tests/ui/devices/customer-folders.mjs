import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

// customerFolders sorts the device tree's root groups and ungrouped devices into
// one folder per visible customer.
const mod={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('ui/devices/fleet/customer-folders.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(id=>{throw Error('Unexpected import '+id);},mod,mod.exports);
const {customerFolders,customerFolderActions}=mod.exports;
let checks=0;

// Fewer than two customers keeps the flat tree.
const groups=[{id:'g1',customerId:'c2'},{id:'g2',customerId:'c10'},{id:'g3',customerId:'c2'}];
const loose=[{id:'d1',customerId:'c10'},{id:'d2',customerId:'c2'}];
assert.equal(customerFolders(undefined,groups,loose,loose),null,'no customer list');
assert.equal(customerFolders([],groups,loose,loose),null,'empty customer list');
assert.equal(customerFolders([{id:'c2',name:'Kunde 2'}],groups,loose,loose),null,'one customer');
checks+=3;

// Folders by name, numeric, then by id; the input order stays inside a folder.
const customers=[{id:'c10',name:'Kunde 10'},{id:'c2',name:'Kunde 2'}];
let layout=customerFolders(customers,groups,loose,loose);
assert.deepEqual(layout.folders.map(folder=>folder.name),['Kunde 2','Kunde 10'],'numeric name order');
assert.deepEqual(layout.folders[0].groupIds,['g1','g3'],'root groups of Kunde 2 in input order');
assert.deepEqual(layout.folders[0].deviceIds,['d2'],'ungrouped device of Kunde 2');
assert.deepEqual(layout.folders[1].groupIds,['g2']);assert.deepEqual(layout.folders[1].deviceIds,['d1']);
assert.deepEqual(layout.rest,{groupIds:[],deviceIds:[]},'nothing left over');
assert.deepEqual(Object.keys(layout.folders[0]).sort(),['count','deviceIds','groupIds','id','name']);
checks+=7;
const reversed=customerFolders(customers,[...groups].reverse(),[...loose].reverse(),loose);
assert.deepEqual(reversed.folders[0].groupIds,['g3','g1'],'the folder keeps the caller order');checks++;
const twins=customerFolders([{id:'b',name:'Gleich'},{id:'a',name:'Gleich'}],[{id:'x',customerId:'b'},{id:'y',customerId:'a'}],[],[]);
assert.deepEqual(twins.folders.map(folder=>folder.id),['a','b'],'equal names fall back to the id');checks++;

// The count covers grouped devices and permission-only targets of the customer.
const tree=[...loose,{id:'d3',customerId:'c2'},{id:'d4',customerId:'c2'},{id:'p1',customerId:'c10'},{id:'x1',customerId:'gone'},{id:'x2'}];
layout=customerFolders(customers,groups,loose,tree);
assert.equal(layout.folders.find(folder=>folder.id==='c2').count,3,'Kunde 2: ungrouped d2 plus grouped d3 and d4');
assert.equal(layout.folders.find(folder=>folder.id==='c10').count,2,'Kunde 10: d1 plus the permission target p1');
checks+=2;

// Every visible customer is a folder, also without root groups and ungrouped devices: the empty one has count 0.
layout=customerFolders([...customers,{id:'c3',name:'Kunde 3'},{id:'c4',name:'Kunde 4'}],groups,loose,[...tree,{id:'d9',customerId:'c3'}]);
assert.deepEqual(layout.folders.map(folder=>folder.id),['c2','c3','c4','c10'],'every customer has a folder, in name order');
assert.deepEqual(layout.folders.find(folder=>folder.id==='c4'),{id:'c4',name:'Kunde 4',groupIds:[],deviceIds:[],count:0},'an empty customer: no groups, no devices, count 0');
assert.equal(layout.folders.find(folder=>folder.id==='c3').count,1,'a customer with only a grouped device elsewhere keeps its count');checks+=3;

// Unknown or missing customers stay in the rest, groups and devices apart.
layout=customerFolders(customers,[{id:'g0'},...groups,{id:'g9',customerId:'inactive'}],[{id:'d0',customerId:'inactive'},...loose,{id:'d8',customerId:null}],tree);
assert.deepEqual(layout.rest,{groupIds:['g0','g9'],deviceIds:['d0','d8']},'rest keeps input order');
assert.deepEqual(layout.folders.flatMap(folder=>[...folder.groupIds,...folder.deviceIds]).sort(),['d1','d2','g1','g2','g3']);
checks+=2;

// The function is pure: inputs stay untouched.
const frozen=Object.freeze([Object.freeze({id:'f',customerId:'c2'})]);
assert.doesNotThrow(()=>customerFolders(Object.freeze([...customers]),frozen,frozen,frozen));checks++;
assert.doesNotMatch(fs.readFileSync('ui/devices/fleet/customer-folders.ts','utf8'),/^import (?!type)/m,'no runtime imports');checks++;

// The folder actions in menu order, per right (tree menu and customer view header).
const actionIds=rights=>customerFolderActions(rights).map(entry=>entry.action);
assert.deepEqual(actionIds({canCreateRootGroup:false,canManageCustomers:false}),[]);
assert.deepEqual(actionIds({canCreateRootGroup:true,canManageCustomers:false}),['create-group']);
assert.deepEqual(actionIds({canCreateRootGroup:false,canManageCustomers:true}),['manage-customer','customer-access','customer-installers']);
assert.deepEqual(customerFolderActions({canCreateRootGroup:true,canManageCustomers:true}),[{action:'create-group',label:'tree.customer.createGroup'},{action:'manage-customer',label:'tree.customer.manage'},{action:'customer-access',label:'tree.customer.access'},{action:'customer-installers',label:'tree.customer.installers'}]);
checks+=4;
// The two drawer entries end with an ellipsis (they open a drawer) in both catalogs; Installers opens a page and has none.
const {translateModule}=await import('../../support/i18n-stubs.mjs');
assert.deepEqual(['tree.customer.manage','tree.customer.access','tree.customer.installers'].map(key=>translateModule.translate('en',key)),['Manage customer…','Technician access…','Installers']);
assert.deepEqual(['tree.customer.manage','tree.customer.access','tree.customer.installers'].map(key=>translateModule.translate('de',key)),['Kunde verwalten…','Technikerzugriff…','Installer']);checks+=2;

console.log(`customer folders: ${checks} checks passed`);
