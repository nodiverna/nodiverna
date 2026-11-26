// Sorting of the device table (ui/devices/fleet/fleet-sort.ts): reversible order, natural versions and names, missing values,
// free space, severity, health and stable ties; the optional Manufacturer column (sort by display name, empty last), the
// search over manufacturer and model, and the manufacturers of the sample devices.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {compareFleetDevices,fleetSortState,nextFleetSort}=await import('../../../ui/devices/fleet/fleet-sort.ts');
const now=Date.now(),snapshot={os:'Microsoft Windows 11 Pro',cpu:20,memory:40,agentVersion:'4.6.7',disks:[{name:'C:',totalGb:100,freeGb:60}],collectionErrors:[],rebootPending:false};
const {defaultAlertSettings,evaluateAlertRules}=await import('../../../lib/alert-rules.ts');
// The console route attaches the issues it evaluated; the fixtures get them from the default rules.
const withIssues=device=>({...device,issues:evaluateAlertRules(device,defaultAlertSettings(),now)});
const server=(id,name,changes={})=>withIssues({id,name,lastSeen:now,revoked:0,management:0,snapshot:{...snapshot},...changes});
const devices=[server('b','PC-10',{snapshot:{...snapshot,cpu:0,memory:0,agentVersion:'4.10.0',disks:[{name:'C:',totalGb:200,freeGb:40}]}}),server('a','PC-2',{groupName:'Entwicklung'}),server('c','PC-1',{lastSeen:now-180000,snapshot:{...snapshot,cpu:99,memory:99}}),server('d','PC-20',{snapshot:null,lastSeen:null})];
const sorted=sort=>[...devices].sort((a,b)=>compareFleetDevices(a,b,sort,now)).map(device=>device.id);
assert.deepEqual(sorted('name'),['c','a','b','d']);assert.deepEqual(sorted('name:desc'),['d','b','a','c']);
assert.deepEqual(sorted('cpu'),['a','b','c','d'],'zero is valid; offline and missing loads follow live readings');
assert.deepEqual(sorted('cpu:asc'),['b','a','c','d'],'missing readings stay last when reversed');
assert.deepEqual(sorted('memory:desc'),['a','b','c','d']);
assert.deepEqual(sorted('disk'),['b','c','a','d'],'free space sorts by displayed GB, including cached offline inventory');
assert.deepEqual(sorted('agent:desc'),['b','c','a','d'],'versions sort numerically and unknown versions stay last');
assert.deepEqual(sorted('group:desc'),['a','c','b','d']);
assert.deepEqual(sorted('heartbeat'),['a','b','c','d']);
assert.deepEqual(sorted('connection'),['a','b','c','d']);
assert.deepEqual(sorted('os:asc'),['c','a','b','d']);
const critical=server('critical','Critical',{snapshot:{...snapshot,cpu:95}}),warning=server('warning','Warning',{snapshot:{...snapshot,rebootPending:true}});
assert.ok(compareFleetDevices(critical,warning,'issues',now)<0);assert.ok(compareFleetDevices(warning,devices[0],'issues',now)<0);
assert.deepEqual(fleetSortState('invalid'),{key:'name',direction:'asc'});
assert.equal(nextFleetSort('name','name'),'name:desc');assert.equal(nextFleetSort('name:desc','name'),'name:asc');
assert.equal(nextFleetSort('name','cpu'),'cpu:desc');assert.equal(nextFleetSort('cpu:desc','disk'),'disk:asc');
const ordered=sorted('cpu:desc');assert.deepEqual(devices.map(device=>device.id),['b','a','c','d'],'sorting a copy leaves the scoped inventory unchanged');
assert.deepEqual([...devices].reverse().sort((a,b)=>compareFleetDevices(a,b,'cpu:desc',now)).map(device=>device.id),ordered,'ties are stable across refreshed inventory order');
// OS support sorts by days left (unknown last), BitLocker by status (problems first, not reported last).
const support=(id,osSupport)=>server(id,id,{snapshot,osSupport});
const byDays=[support('long',{status:'supported',daysLeft:900}),support('none',{status:'unknown',reason:'no-entry'}),support('ended',{status:'ended',daysLeft:0}),support('soon',{status:'ending',daysLeft:30}),server('old','old',{snapshot})];
assert.deepEqual([...byDays].sort((a,b)=>compareFleetDevices(a,b,'osSupport:asc',now)).map(device=>device.id),['ended','soon','long','none','old'],'OS support ascending by days left, unknown last');
assert.deepEqual([...byDays].sort((a,b)=>compareFleetDevices(a,b,'osSupport:desc',now)).map(device=>device.id),['long','soon','ended','none','old'],'unknown stays last when descending');
assert.equal(fleetSortState('bitlocker').key,'bitlocker');assert.equal(fleetSortState('osSupport').direction,'asc');
// Health: ascending by default; the first press orders Critical, Warning, Good, No data, inside a level the
// lowest score first, then the name; no data stays last in both directions.
const alarm=(level,key)=>({id:level+key,ruleId:'cpu',key,level,peakLevel:level,peakValue:null,threshold:null,params:{},startedAt:now,openedAt:now,acknowledged:null,muted:null});
const healthDevice=(id,alerts,lastSeen=now)=>server(id,id,{snapshot,lastSeen,alerts});
const byHealth=[healthDevice('good',[]),healthDevice('none',[],null),healthDevice('crit60',[alarm('critical','a')]),healthDevice('warn60',[alarm('warning','a'),alarm('warning','b'),alarm('info','c'),alarm('info','d')]),healthDevice('warn85',[alarm('warning','a')]),healthDevice('warn40',[alarm('warning','a'),alarm('warning','b'),alarm('warning','c'),alarm('warning','d')]),healthDevice('zero',[alarm('critical','a'),alarm('critical','b'),alarm('critical','c')])];
assert.equal(fleetSortState('health').direction,'asc','health sorts ascending by default');
assert.equal(nextFleetSort('name','health'),'health:asc');assert.equal(nextFleetSort('health:asc','health'),'health:desc');
assert.deepEqual([...byHealth].sort((a,b)=>compareFleetDevices(a,b,'health',now)).map(device=>device.id),['zero','crit60','warn40','warn60','warn85','good','none'],'Critical, Warning, Good, No data; a warning at 40 after a critical at 60; inside a level the lowest score first');
assert.deepEqual([...byHealth].sort((a,b)=>compareFleetDevices(a,b,'health:desc',now)).map(device=>device.id),['good','warn85','warn60','warn40','crit60','zero','none'],'no data stays last when descending');
// ---- The Devices table on DataTable: the string sort as TableSort, identical to nextFleetSort ----
{
 const {fleetSortFirst,fleetTableSort,fleetSortValue}=await import('../../../ui/devices/fleet/fleet-sort.ts');
 const {sortHeadProps,DataTable}=await import('../../../ui/kit/data-table.tsx');
 const {fleetTableColumns}=await import('../../../ui/devices/fleet/fleet.tsx');
 const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
 const {translate}=await import('../../../lib/i18n/translate.ts');
 const {defaultFleetColumns}=await import('../../../ui/devices/fleet/fleet-columns.ts');
 const React=(await import('react')).default,{renderToStaticMarkup}=await import('react-dom/server');
 const keys=['name','connection','health','customer','group','os','manufacturer','cpu','memory','disk','agent','osSupport','bitlocker','diskHealth','ssdWear','battery','heartbeat'];
 const first=Object.fromEntries(keys.map(key=>[key,fleetSortFirst(key)]));
 assert.deepEqual(Object.keys(first).filter(key=>first[key]==='desc'),['cpu','memory','ssdWear','heartbeat'],'desc first for cpu, memory, heartbeat and ssdWear; asc otherwise');
 assert.equal(fleetSortFirst('health'),'asc','the first press on Health shows Critical first');
 const all=Object.fromEntries([...Object.keys(defaultFleetColumns)].map(key=>[key,true]));
 const t=(key,params)=>translate('en',key,params);
 const columns=fleetTableColumns({columns:all,showCustomer:true,now,locale:'en',t,menu:()=>null});
 const sortable=columns.filter(column=>column.sort).map(column=>column.id);
 assert.deepEqual(sortable,keys,'every sortable column, in table order, with its fleet sort key as id');
 assert.ok(columns.every(column=>!column.sort||column.sort.first===fleetSortFirst(column.id)),'each column starts in fleetSortFirst');
 const heads=sort=>{const html=renderToStaticMarkup(React.createElement(LocaleProvider,{locale:'en'},React.createElement(DataTable,{columns,rows:[],rowKey:row=>row.id,label:'Devices',empty:{icon:()=>null,title:'None'},sort:fleetTableSort(sort),onSort:()=>{}})));return Object.fromEntries([...html.matchAll(/<th scope="col"[^>]*aria-sort="([a-z]+)"[^>]*><button type="button" class="sdx-sort[^"]*" aria-label="([^"]+): sort (ascending|descending)"/g)].map(match=>[match[2],{sort:match[1],next:match[3]==='ascending'?'asc':'desc'}]));};
 const labelOf=Object.fromEntries(columns.map(column=>[column.id,column.label]));
 for(const current of ['name',...keys.flatMap(key=>[key+':asc',key+':desc'])]){
  const shown=heads(current);
  for(const key of keys){
   const props=sortHeadProps(fleetTableSort(current),key,fleetSortFirst(key),next=>{props.pressed=fleetSortValue(next);});
   const expected=nextFleetSort(current,key);
   assert.equal(shown[labelOf[key]].next,expected.split(':')[1],current+" → "+key+": the button names the direction of nextFleetSort");
   assert.equal(shown[labelOf[key]].sort,fleetSortState(current).key===key?(fleetSortState(current).direction==='asc'?'ascending':'descending'):'none',current+": aria-sort of "+key);
   props.onSort();
   assert.equal(props.pressed,expected,current+" → "+key+": one press gives the sort of nextFleetSort");
   assert.deepEqual(sorted(props.pressed),sorted(expected),'and the same order');
  }
 }
}
// ---- the Manufacturer column: by display name, devices without a manufacturer last in both directions ----
{
 const {fleetSearchText,defaultFleetColumns,fleetColumnKeys,fleetColumnNames}=await import('../../../ui/devices/fleet/fleet-columns.ts');
 const made=(id,manufacturer,model,hardware)=>server(id,'PC-'+id,{snapshot:{...snapshot,manufacturer,model,...(hardware?{hardware:{collectedAt:'',intervalSeconds:0,complete:true,system:{manufacturer:hardware,model:'Latitude 7440',systemType:null,uuid:null}}}:{})}});
 const list=[made('1','LENOVO','20XW'),made('2','To be filled by O.E.M.',''),made('3','Dell Inc.','OptiPlex 7010'),made('4','Microsoft Corporation','Virtual Machine'),made('5','Acme','x','Hewlett Packard Enterprise'),server('6','PC-6',{snapshot:null})];
 const order=sort=>[...list].sort((a,b)=>compareFleetDevices(a,b,sort,now)).map(device=>device.id);
 assert.deepEqual(order('manufacturer'),['3','5','1','4','2','6'],'Dell, HPE (the inventory wins), Lenovo, Microsoft, then none');
 assert.deepEqual(order('manufacturer:desc'),['4','1','5','3','2','6'],'reversed, none stays last');
 assert.equal(fleetSortState('manufacturer').direction,'asc','ascending first');
 assert.deepEqual([fleetColumnKeys.indexOf('manufacturer'),fleetColumnKeys.indexOf('os')+1,defaultFleetColumns.manufacturer,fleetColumnNames.manufacturer],[fleetColumnKeys.indexOf('os')+1,fleetColumnKeys.indexOf('manufacturer'),false,'fleet.col.manufacturer'],'optional, default off, right after the OS');
 const search=fleetSearchText(list[2]);
 assert.ok(['dell','dell inc.','optiplex 7010'].every(term=>search.includes(term)),'the search finds the display name, the raw value and the model');
 assert.ok(fleetSearchText(list[4]).includes('hpe')&&fleetSearchText(list[4]).includes('latitude 7440'),'the inventory manufacturer and model');
 // The sample devices show the logos and the fallback (ui/shell/demo.ts).
 const {demoData}=await import('../../../ui/shell/demo.ts');
 const {deviceManufacturer}=await import('../../../ui/devices/hardware/manufacturer-model.ts');
 assert.deepEqual(Object.fromEntries(demoData().servers.map(device=>{const {manufacturer,model}=deviceManufacturer(device);return [device.id,[manufacturer?.name,manufacturer?.logo,model]];})),{
  'demo-app':['Microsoft',false,'Virtual Machine'],'demo-dc':['Lenovo',true,'ThinkSystem SR630'],'demo-db':['Dell',true,'PowerEdge R750'],'demo-file':['HPE',false,'ProLiant DL380 Gen10'],
 },'Dell, HPE, Lenovo and the Microsoft fallback');
}
console.log('PASS fleet table sorting: reversible sorting, natural versions/names, offline/missing/zero values, displayed free space, severity, health by level, then score, and deterministic refresh ties.');
