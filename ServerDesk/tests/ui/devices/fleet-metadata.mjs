// Fleet search, columns and the tag filter with device descriptions and tags
// (pure): fleetSearchText and parseFleetColumns in ui/devices/fleet/fleet-columns.ts and the
// tag filter of ui/devices/fleet/fleet-tags.ts, which matches own and inherited effective
// tags, names without regard to case and values exactly.
import assert from 'node:assert/strict';
import fs,{readFileSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),cache=new Map();
function load(file){
 const absolute=path.resolve(file);if(cache.has(absolute))return cache.get(absolute).exports;
 const fixture={exports:{}};cache.set(absolute,fixture);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const local=id=>{const stub=i18nRequire(id);if(stub)return stub;if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.resolve(id.slice(2)):path.resolve(path.dirname(absolute),id);return load([base,base+'.ts'].find(candidate=>fs.existsSync(candidate)));}return require(id);};
 new Function('require','module','exports',code)(local,fixture,fixture.exports);return fixture.exports;
}
const {defaultFleetColumns,fleetColumnKeys,fleetColumnNames,fleetSearchText,parseFleetColumns}=load('ui/devices/fleet/fleet-columns.ts');
const {fleetTagNames,fleetTagValues,matchesFleetTagFilter}=load('ui/devices/fleet/fleet-tags.ts');
const {fleetFilters,fleetFilterLabels,fleetFilterMatch}=load('ui/devices/fleet/fleet-filters.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const tag=(name,value,groupId=null)=>({name,value,inherited:groupId!==null,groupId});
const device=(id,changes={})=>({id,name:id.toUpperCase(),createdAt:0,lastSeen:null,revoked:0,management:0,snapshot:null,...changes});

// ---- Search ----
const described=device('srv-a',{description:'Accounting\nRoom 2.14',tags:[tag('Environment','Production'),tag('Site','Berlin','g1')]});
const search=text=>fleetSearchText(described).includes(text.toLowerCase());
check(search('room 2.14'),true,'the search matches the description, case-insensitively');
check(search('ACCOUNTING'),true,'upper case finds the description');
check(search('environment'),true,'the search matches an own tag name');
check(search('production'),true,'and its value');
check(search('berlin'),true,'and the value of an inherited tag');
check(search('site'),true,'and the name of an inherited tag');
check(search('munich'),false,'other text does not match');
check(fleetSearchText(device('plain')),'plain','a device without description and tags still has its name');
// A renamed device is found by its previous names.
const renamed=fleetSearchText(device('srv-new',{previousNames:['SRV-OLD','Fileserver Berlin']}));
check([renamed.includes('srv-old'),renamed.includes('fileserver berlin'),renamed.includes('srv-new')],[true,true,true],'the search matches the current and every previous name');
// A minimal or partial snapshot (seed data, an agent mid-registration) may lack the networks list or a network's
// addresses: the search must not throw (one bad device would blank the whole Devices page) and still finds every other field.
const minimal={protocolVersion:3,os:'Windows Server 2022',agentVersion:'1.0.0',mode:'ReadOnly'};
const partial=changes=>device('srv-min',{groupName:'Berlin',customerName:'Contoso',description:'Edge box',previousNames:['SRV-PREV'],tags:[tag('Role','Edge')],snapshot:{...minimal,...changes}});
for(const [name,snapshot] of [['no networks key',{}],['networks: null',{networks:null}],['a network without addresses',{networks:[{name:'Ethernet'}]}],['a null network entry',{networks:[null]}]]){
 let text;
 assert.doesNotThrow(()=>{text=fleetSearchText(partial(snapshot));},`${name}: fleetSearchText does not throw`);checks++;
 check(typeof text,'string',`${name}: fleetSearchText returns a string`);
 check(['srv-min','windows server 2022','berlin','contoso','edge box','srv-prev','role','edge'].filter(part=>!text.includes(part)),[],`${name}: name, OS, group, customer, description, previous names and tags are still in the text`);
}
{const full=fleetSearchText(partial({networks:[{name:'Ethernet',addresses:['10.0.0.5','fe80::1']},{name:'Wi-Fi',addresses:['192.168.1.20']}]}));
 check(['10.0.0.5','fe80::1','192.168.1.20'].filter(address=>!full.includes(address)),[],'with the lists present, every address of every network is in the text');}

// ---- Columns ----
check(fleetColumnKeys.slice(0,4),['customer','group','description','tags'],'description and tags follow the group');
ok(!fleetColumnKeys.includes('health'),'Health is a fixed column, not in the column menu');
check(Object.entries(defaultFleetColumns).filter(([,on])=>on).map(([key])=>key),['customer','group','cpu','memory','disk'],'by default: customer (where it tells devices apart), group, CPU, RAM and Free');
check([defaultFleetColumns.description,defaultFleetColumns.tags],[false,false],'description and tags are off by default');
check([fleetColumnNames.description,fleetColumnNames.tags],['fleet.col.description','fleet.col.tags'],'menu names');
const old={customer:true,group:false,os:true,cpu:false,memory:true,disk:true,agent:false};
check(parseFleetColumns(old),{...old,description:false,tags:false,manufacturer:false,osSupport:false,bitlocker:false,diskHealth:false,ssdWear:false,battery:false},'a selection stored before the new columns gets their defaults');
check([parseFleetColumns({...old,description:true,tags:true}).description,parseFleetColumns({...old,description:true,tags:true}).tags],[true,true],'a stored description: true or tags: true stays on');
check(parseFleetColumns({...old,description:false,tags:false}).description,false,'a stored choice stays');
ok(!('health' in parseFleetColumns({...old,health:false})),'a stored health key is ignored');

// ---- Health filters ----
check(fleetFilters.slice(0,4),['all','health-critical','health-warning','health-good'],'the health filters follow all');
check([fleetFilterLabels['health-critical'],fleetFilterLabels['health-warning'],fleetFilterLabels['health-good']],['fleet.filter.healthCritical','fleet.filter.healthWarning','fleet.filter.healthGood'],'health filter labels');
const open=level=>({id:level,ruleId:'cpu',key:level,level,peakLevel:level,peakValue:null,threshold:null,params:{},startedAt:0,openedAt:0,acknowledged:null,muted:null});
const healthDevices={critical:device('crit',{lastSeen:1,alerts:[open('critical'),open('warning')]}),warning:device('warn',{lastSeen:1,alerts:[open('warning')]}),good:device('good',{lastSeen:1,alerts:[open('info')]}),unknown:device('none')};
const matching=filter=>Object.entries(healthDevices).filter(([,item])=>fleetFilterMatch(item,filter,0)).map(([state])=>state);
check(matching('health-critical'),['critical'],'critical matches only the critical state');
check(matching('health-warning'),['warning'],'warning matches only the warning state, not a critical device with a warning');
check(matching('health-good'),['good'],'good matches info-only devices; no data matches none');
check(matching('all'),['critical','warning','good','unknown'],'all matches every device');

// ---- Tag filter ----
const devices=[
 device('a',{tags:[tag('Environment','Production'),tag('Owner','IT','g1')]}),
 device('b',{tags:[tag('environment','Test','g2')]}),
 device('c',{tags:[tag('ENVIRONMENT','Production','g2'),tag('Critical','')]}),
 device('d'),
];
check(fleetTagNames(devices),['Critical','ENVIRONMENT','Owner'],'names are de-duplicated without regard to case and sorted');
check(fleetTagValues(devices,'environment'),['Production','Test'],'the values of one name, without empty ones');
check(fleetTagValues(devices,'Critical'),[],'a name without values has none');
const ids=filter=>devices.filter(item=>matchesFleetTagFilter(item,filter)).map(item=>item.id);
check(ids(null),['a','b','c','d'],'no filter matches every device');
check(ids({name:'environment',value:null}),['a','b','c'],'any value: the name matches without regard to case, own and inherited');
check(ids({name:'Environment',value:'Production'}),['a','c'],'a value matches exactly');
check(ids({name:'Environment',value:'production'}),[],'values compare with case');
check(ids({name:'Owner',value:'IT'}),['a'],'an inherited tag matches');
check(ids({name:'Critical',value:null}),['c'],'a tag without a value matches any value');
check(ids({name:'Missing',value:null}),[],'an unknown name matches nothing');
// One case rule through tagKey: İX and ix are two names (the key of İX is
// i + U+0307 + x), Umgebung and umgebung are one.
const keyed=[
 device('k1',{tags:[tag('İX','dotted'),tag('Umgebung','Prod')]}),
 device('k2',{tags:[tag('ix','plain'),tag('umgebung','Test','g1')]}),
];
check(fleetTagNames(keyed),['ix','İX','Umgebung'],'İX and ix are two names, Umgebung and umgebung one');
check(keyed.filter(item=>matchesFleetTagFilter(item,{name:'ix',value:null})).map(item=>item.id),['k2'],'the filter ix does not match İX');
check(keyed.filter(item=>matchesFleetTagFilter(item,{name:'İx',value:null})).map(item=>item.id),['k1'],'the filter İx matches İX only');
check(keyed.filter(item=>matchesFleetTagFilter(item,{name:'UMGEBUNG',value:null})).map(item=>item.id),['k1','k2'],'the filter UMGEBUNG matches both casings');
check(fleetTagValues(keyed,'umgebung'),['Prod','Test'],'the values of Umgebung and umgebung together');
// The client compares tag names only through tagKey; fleetSearchText is free text.
for(const file of ['ui/devices/fleet/fleet-tags.ts','ui/devices/configuration/tags.tsx'])check(/toLowerCase|toLocaleLowerCase|localeCompare/.test(readFileSync(file,'utf8')),false,`${file} adds no other lowercasing of tag names`);
check(readFileSync('ui/devices/fleet/fleet.tsx','utf8').match(/\.toLowerCase\(\)/g)?.length,1,'fleet.tsx lowercases only the free-text search');

// ---- Wiring in the fleet view ----
const fleet=readFileSync('ui/devices/fleet/fleet.tsx','utf8');
check(/matchesFleetTagFilter\(server,tagFilter\)&&fleetSearchText\(server\)/.test(fleet),true,'the fleet combines the tag filter with search, status and type');
check(/const resetFilters=\(\)=>setFilters\(emptyFleetFilters\);/.test(fleet)&&/setSearch\(''\);setStatus\('all'\);resetFilters\(\);/.test(fleet)&&/emptyFleetFilters:FleetFilters=\{type:'all',filter:'all',tagName:'',tagValue:null\}/.test(fleet),true,'"Reset filter" also resets the tag filter');
check(/emptyFleetFilters:FleetFilters=\{type:'all',filter:'all',/.test(fleet)&&/fleetFilterMatch\(server,filter,now\)&&matchesFleetTagFilter/.test(fleet),true,'the health filter is the Filter select: it combines with the others and resets with them');
console.log(`PASS fleet metadata (${checks} checks): search over description and tags (and snapshots without networks or addresses), the new columns with defaults for old selections, the health filters, and the tag filter over own and inherited tags.`);
