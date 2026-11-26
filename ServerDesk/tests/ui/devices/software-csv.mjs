// The CSV of the software tab (ui/devices/inventory/software-csv.ts): UTF-8 BOM, ";" and CRLF,
// localized headers, the shown rows in their order and neutralized cells
// through the shared cell() of ui/devices/fleet/fleet-csv.ts. No database.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {softwareCsv,softwareCsvFileName}=await import('../../../ui/devices/inventory/software-csv.ts');
const {cell}=await import('../../../ui/devices/fleet/fleet-csv.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const rows=[
 {name:'Google Chrome',version:'120.0.6099.130',publisher:'Google LLC',deviceCount:2,deviceNames:['SRV-APP01','SRV-SQL01']},
 {name:'=HYPERLINK("http://evil")',version:'+1',publisher:'-cmd',deviceCount:1,deviceNames:['@host']},
 {name:'Tool "quoted"',version:null,publisher:null,deviceCount:1,deviceNames:['\tTAB']},
];
const en=softwareCsv(rows,'en');
check(en.charCodeAt(0),0xFEFF,'UTF-8 BOM first');
const lines=en.slice(1).split('\r\n');
check(lines.length,4,'header plus one line per row, CRLF');
check(lines[0],'"Product";"Version";"Publisher";"Devices";"Device names"','English headers with ";"');
check(lines[1],'"Google Chrome";"120.0.6099.130";"Google LLC";"2";"SRV-APP01, SRV-SQL01"','the shown row with the joined device names');
check(lines[2],`"'=HYPERLINK(""http://evil"")";"'+1";"'-cmd";"1";"'@host"`,'formula cells are neutralized and quotes doubled');
check(lines[3],`"Tool ""quoted""";"";"";"1";"'\tTAB"`,'empty values and a leading tab');
check(softwareCsv(rows,'de').slice(1).split('\r\n')[0],'"Produkt";"Version";"Hersteller";"Geräte";"Gerätenamen"','German headers');
check(softwareCsv([],'en'),'﻿"Product";"Version";"Publisher";"Devices";"Device names"','no rows: only the header');
check(softwareCsv([...rows].reverse(),'en').slice(1).split('\r\n')[1].startsWith('"Tool'),true,'the given order');
check(cell('=1'),`"'=1"`,'the shared cell is exported');
// With the vulnerability check on: four columns after Devices, every cell through cell().
const verdict=(status,highest,count,knownExploited,fixedIn)=>({status,count,highest,knownExploited,fixedIn,noFixCount:0});
const checked=[{...rows[0],verdict:verdict('vulnerable','critical',4,true,'120.0.6099.224')},{...rows[1],verdict:verdict('vulnerable','medium',1,false,'=1+1')},{...rows[2],verdict:verdict('clean',null,0,false,null)},{name:'Other',version:'1',publisher:null,deviceCount:1,deviceNames:[],verdict:verdict('unchecked',null,0,false,null)}];
const on=softwareCsv(checked,'en',true).slice(1).split('\r\n');
check(on[0],'"Product";"Version";"Publisher";"Devices";"Highest severity";"Vulnerabilities";"Known exploited";"Fixed in";"Device names"','the vulnerability columns after Devices');
check(on[1],'"Google Chrome";"120.0.6099.130";"Google LLC";"2";"Critical";"4";"Yes";"120.0.6099.224";"SRV-APP01, SRV-SQL01"','a vulnerable row');
check(on[2].split(';').slice(4,8),['"Medium"','"1"','"No"',`"'=1+1"`],'a formula in Fixed in is neutralized');
check([on[3].split(';').slice(4,8),on[4].split(';').slice(4,8)],[['""','"0"','"No"','""'],['""','""','""','""']],'clean and not checked rows');
check(softwareCsv(checked,'de',true).slice(1).split('\r\n')[1].split(';').slice(4,7),['"Kritisch"','"4"','"Ja"'],'German values');
check(softwareCsv(checked.slice(0,3),'en'),softwareCsv(rows,'en'),'with the check off the output is unchanged');
const now=new Date(2026,9,28,12).getTime();
check([softwareCsvFileName(now,'en'),softwareCsvFileName(now,'de')],['ServerDesk-Software-2026-10-28.csv','ServerDesk-Software-2026-10-28.csv'],'file names with the local date');
console.log(`PASS software csv (${checks} checks): BOM, ";" and CRLF, localized headers, order, neutralized cells and file names.`);
