// The CSV export of the device table (ui/devices/fleet/fleet-csv.ts, ui/devices/fleet/fleet-export.tsx): BOM, separators,
// quoting, the selected columns and the texts.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
import {blockedReasons} from '../../support/blocked-buttons.mjs';
const require=createRequire(import.meta.url),cache=new Map();
function load(file){
 const absolute=path.resolve(file);if(cache.has(absolute))return cache.get(absolute).exports;
 const fixture={exports:{}};cache.set(absolute,fixture);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const local=id=>{const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.resolve(id.slice(2)):path.resolve(path.dirname(absolute),id);return load([base,base+'.ts',base+'.tsx'].find(candidate=>fs.existsSync(candidate)));}return require(id);};
 new Function('require','module','exports',code)(local,fixture,fixture.exports);return fixture.exports;
}
const {fleetCsv,fleetCsvFileName,fleetCsvTags}=load('ui/devices/fleet/fleet-csv.ts');
const {compareFleetDevices}=load('ui/devices/fleet/fleet-sort.ts');
const {default:FleetCsvExport}=load('ui/devices/fleet/fleet-export.tsx');

const heartbeat=Date.UTC(2026,9,16,8,30),now=heartbeat+60000;
const snapshot={os:'Microsoft Windows Server 2022',cpu:20,memory:40,agentVersion:' 4.6.7 ',disks:[],networks:[{name:'Ethernet',addresses:['10.20.30.40']}],collectionErrors:[],rebootPending:false};
const server=(id,name,changes={})=>({id,name,createdAt:0,lastSeen:heartbeat,revoked:0,management:0,snapshot:{...snapshot},...changes});
const devices=[server('device-id-alpha','SRV-A',{groupName:'Rechenzentrum'}),server('device-id-beta','PC-B',{snapshot:null,lastSeen:null})];
const parse=csv=>csv.slice(1).split('\r\n').map(line=>line.split(';'));

// BOM, separators, header, no trailing line break.
const csv=fleetCsv(devices);
assert.ok(csv.startsWith('﻿'),'starts with a UTF-8 BOM');
assert.ok(!csv.endsWith('\r\n')&&!csv.endsWith('\n'),'no trailing line break');
const lines=csv.slice(1).split('\r\n');
assert.equal(lines.length,3);assert.ok(lines.every(line=>!line.includes('\n')),'rows are separated by CRLF only');
assert.equal(lines[0],'"Name";"Gruppe";"Beschreibung";"Tags";"Betriebssystem";"Gerätetyp";"Hersteller";"Modell";"Agent-Version";"Letzter Heartbeat"');
assert.equal(fleetCsv([]),'﻿"Name";"Gruppe";"Beschreibung";"Tags";"Betriebssystem";"Gerätetyp";"Hersteller";"Modell";"Agent-Version";"Letzter Heartbeat"');
assert.equal(fleetCsv([],{},'en').slice(1),'"Name";"Group";"Description";"Tags";"Operating system";"Device type";"Manufacturer";"Model";"Agent version";"Last heartbeat"','English headers in the same order');

// Values and missing snapshot.
assert.equal(lines[1],'"SRV-A";"Rechenzentrum";"";"";"Windows Server 2022";"Server";"";"";"4.6.7";"2026-10-16T08:30:00.000Z"');
assert.equal(lines[2],'"PC-B";"";"";"";"";"Gerätetyp noch nicht gemeldet";"";"";"";""');
assert.equal(fleetCsv([server('x','X',{snapshot:{...snapshot,agentVersion:undefined}})]).split('\r\n')[1],'"X";"";"";"";"Windows Server 2022";"Server";"";"";"";"2026-10-16T08:30:00.000Z"','missing agent version is an empty cell');

// Description and tags: line breaks stay inside the quoted cell; tags sorted by name, Name=Value or Name.
const tag=(name,value,groupId=null)=>({name,value,inherited:groupId!==null,groupId});
const tagged=fleetCsv([server('t','SRV-T',{groupName:'Berlin',description:'Accounting\nroom 2.14',tags:[tag('site','HQ','g1'),tag('Critical',''),tag('Environment','Production')]})]);
assert.equal(tagged.slice(1).split('\r\n')[1],'"SRV-T";"Berlin";"Accounting\nroom 2.14";"Critical; Environment=Production; site=HQ";"Windows Server 2022";"Server";"";"";"4.6.7";"2026-10-16T08:30:00.000Z"','description with a line break and the tags cell with inherited and value-less tags');
assert.equal(fleetCsvTags([tag('b','2'),tag('A',''),tag('a2','x','g')]),'A; a2=x; b=2','tags sort without regard to case');
assert.equal(fleetCsvTags(undefined),'','no tags give an empty cell');
const injectedMeta=parse(fleetCsv([server('m','M',{description:'=SUM(A1)',tags:[tag('=cmd','x')]}),server('n','N',{description:'plain',tags:[tag('@x','y','g')]})])).slice(1);
assert.deepEqual(injectedMeta.map(row=>[row[2],row[3]]),[['"\'=SUM(A1)"','"\'=cmd=x"'],['"plain"','"\'@x=y"']],'description and tags starting with = or @ are neutralized');

// Order follows the input array, e.g. the sorted list of the fleet view.
const many=[server('1','PC-2'),server('2','PC-10'),server('3','PC-1'),server('4','PC-20')];
const sorted=[...many].sort((a,b)=>compareFleetDevices(a,b,'name:desc',now));
assert.deepEqual(parse(fleetCsv(sorted)).slice(1).map(row=>row[0]),sorted.map(device=>`"${device.name}"`));
assert.deepEqual(parse(fleetCsv(sorted)).slice(1).map(row=>row[0]),['"PC-20"','"PC-10"','"PC-2"','"PC-1"']);
assert.deepEqual(parse(fleetCsv(many)).slice(1).map(row=>row[0]),['"PC-2"','"PC-10"','"PC-1"','"PC-20"'],'no own sorting');

// The device type, the manufacturer (display name, empty without one) and the model after the OS, in both locales.
const made=server('h','PC-H',{snapshot:{...snapshot,os:'Microsoft Windows 11 Pro',manufacturer:'LENOVO',model:'20XW',battery:{collectedAt:'',present:true,batteries:[]},hardware:{collectedAt:'',intervalSeconds:0,complete:true,system:{manufacturer:'Dell Inc.',model:'Latitude 7440',systemType:null,uuid:null}}}});
assert.deepEqual(parse(fleetCsv([made])).slice(1)[0].slice(4,8),['"Windows 11 Pro"','"Laptop"','"Dell"','"Latitude 7440"'],'the hardware inventory wins over the snapshot');
assert.deepEqual(parse(fleetCsv([made],{},'en')).slice(1)[0].slice(5,8),['"Laptop"','"Dell"','"Latitude 7440"'],'English cells');
assert.deepEqual(parse(fleetCsv([server('z','PC-Z',{snapshot:{...snapshot,manufacturer:'To be filled by O.E.M.',model:'Board'}})])).slice(1)[0].slice(6,8),['""','"Board"'],'a placeholder gives an empty manufacturer cell');

// Exactly ten cells per row and no other fields.
assert.ok(parse(csv).every(row=>row.length===10),'every row has ten cells');
for(const hidden of ['10.20.30.40','device-id-alpha','device-id-beta','Ethernet'])assert.ok(!csv.includes(hidden),`${hidden} is not exported`);

// Formula prefixes are neutralized, quotes doubled, header untouched.
const injected=['=1+1','+A','-PC','@SUM(A1)','\tX','\rX','  =X',' @a','=HYPERLINK("x")'];
const injectedRows=parse(fleetCsv(injected.map((name,index)=>server(String(index),name,{groupName:name})))).slice(1);
assert.deepEqual(injectedRows.map(row=>row[0]),['"\'=1+1"','"\'+A"','"\'-PC"','"\'@SUM(A1)"','"\'\tX"','"\'\rX"','"\'  =X"','"\' @a"','"\'=HYPERLINK(""x"")"']);
assert.deepEqual(injectedRows.map(row=>row[1]),injectedRows.map(row=>row[0]),'group cells are neutralized too');
const plain=parse(fleetCsv([server('p','PC-01',{groupName:'a"b'})]))[1];
assert.equal(plain[0],'"PC-01"');assert.equal(plain[1],'"a""b"');

// File name with the local date.
assert.equal(fleetCsvFileName(new Date(2026,9,16,12).getTime()),'ServerDesk-Geraete-2026-10-16.csv');
assert.equal(fleetCsvFileName(new Date(2026,0,5,0,1).getTime()),'ServerDesk-Geraete-2026-01-05.csv');

// Button markup, enabled and blocked.
const enabled=renderToStaticMarkup(React.createElement(FleetCsvExport,{devices,now}));
// The label shows in the kit Tooltip (browser only), so the button carries no native title.
assert.match(enabled,/aria-label="Als CSV exportieren"/);assert.doesNotMatch(enabled,/title=/);
assert.match(enabled,/sdx-icon-btn-framed/);assert.match(enabled,/lucide-download/);assert.doesNotMatch(enabled,/disabled/);
const blocked=renderToStaticMarkup(React.createElement(FleetCsvExport,{devices:[],now}));
// Blocked: focusable (aria-disabled, no native disabled), the reason as its description.
assert.doesNotMatch(blocked,/ disabled=""/);assert.deepEqual(blockedReasons(blocked),['Keine Geräte zum Exportieren.']);

// Click downloads once; errors are caught.
const calls=[],download=(...args)=>{calls.push(args);};
FleetCsvExport({devices,now,download}).props.onClick();
assert.deepEqual(calls,[[fleetCsvFileName(now),fleetCsv(devices),'text/csv;charset=utf-8']]);
FleetCsvExport({devices:[devices[0]],now,download}).props.onClick();assert.equal(calls.length,2);
FleetCsvExport({devices:[],now,download}).props.onClick();assert.equal(calls.length,2,'a blocked button downloads nothing');
let thrown=0;
assert.doesNotThrow(()=>FleetCsvExport({devices,now,download:()=>{thrown++;throw new Error('blocked by browser');}}).props.onClick());
assert.equal(thrown,1);

// Wired into the device toolbar with the visible list: the first of the Toolbar actions (after the kit spacer).
const fleet=fs.readFileSync('ui/devices/fleet/fleet.tsx','utf8');
assert.match(fleet,/import FleetCsvExport from '@\/ui\/devices\/fleet\/fleet-export';/);
assert.match(fleet,/actions=\{<>\s*<FleetCsvExport devices=\{visible\} customer=\{customerColumn\}\/>\s*<FleetAgentUpdateToolbar\/>/);
assert.equal(fleet.match(/<FleetCsvExport /g).length,1);

console.log('PASS fleet CSV export: BOM/;/CRLF format, fixed seven columns with description and tags in list order, empty cells for missing data, formula neutralization, local-date file name, blocked empty export and caught download errors.');
