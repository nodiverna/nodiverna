// The software inventory on PostgreSQL: normalization, the checksum parity with
// the agent, POST /api/agent/software (baseline, installed/updated/removed, a new
// product code, truncated reports, identical checksums, checksum mismatch, 429,
// device token, body limit, parallel reports), the heartbeat's softwareResync,
// GET /api/software/device and GET /api/software (scopes, search, customer
// boundary, 2000-row cap) and the retention through runMaintenance.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {softwareChecksumItems,softwareChecksumExpected} from '../support/software-checksum-fixture.mjs';
import {sql} from '../../runtime/database.mjs';
import {runMaintenance,maintenanceSelections} from '../../scripts/selfhost.mjs';
import {boundaryPhase,everyCustomer} from '../support/customer-separation.mjs';

const uuid=()=>crypto.randomUUID();
const customerA='00000000-0000-4000-8000-000000000100';
let viewer=null,clock=Date.now(),checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
const HttpError=realHttpError;
const d=await sourceDatabase(),db=hookDatabase(d);
const server={db:()=>db,now:()=>clock,config:()=>'',guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
 body:async(request,limit=256000)=>{const text=await request.text();if(Buffer.byteLength(text)>limit)throw new HttpError(413,'Anfrage zu groß.');return JSON.parse(text);},
 requireViewer:async()=>stamped({...viewer}),
 failure:error=>error instanceof HttpError?Response.json({error:error.message,code:error.code},{status:error.status}):Response.json({error:String(error?.message??error)},{status:500})};
// Device bearer: the token names the device; an unknown token is refused like deviceFromBearer.
const tokens=new Map();
const v3={agentFromBearer:async request=>{const token=(request.headers.get('authorization')??'').replace(/^Bearer /,'');const id=tokens.get(token);if(!id)throw new HttpError(401,'Agent nicht freigegeben.');return {id};}};
const imports={'../context':server,'../../context':server,'@/lib/server/context':server,'@/lib/server/agent/agent-protocol':v3,'./agent-protocol':v3,'../agent/agent-protocol':v3};
const load=sourceLoader();
const inventory=load('lib/software-inventory.ts',imports),softwareLib=load('lib/server/devices/software.ts',imports);
const agentApi=load('app/api/agent/software/route.ts',imports),fleetApi=load('app/api/software/route.ts',imports),deviceApi=load('app/api/software/device/route.ts',imports);

const time=Date.now(),insert=(table,row)=>insertRow(d,table,row);
async function persona(name){const id=uuid(),principal='local:'+id;await insert('local_users',{id,username:name,email:name+'@sw.test',display_name:name,auth_principal:principal,auth_email:name+'@sw.test',status:'active',auth_version:1,created_at:time,updated_at:time});return stamped({id,userId:id,label:name+'@sw.test',principal});}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};
async function device(name,groupId,customer=customerA){const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:0,snapshot:null,customer_id:customer});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});tokens.set('token-'+id,id);return id;}

const item=(key,name,version,extra={})=>({key,name,version,publisher:'Vendor',installDate:'2026-01-15',architecture:'x64',scope:'machine',...extra});
const report=async(items,{count=items.length,truncated=count>items.length,checksum}={})=>({checksum:checksum??await inventory.softwareChecksum(items),count,truncated,items});
const send=async(id,body,{token='token-'+id,raw}={})=>{const response=await agentApi.POST(new Request('https://sw.test/api/agent/software',{method:'POST',headers:{'Content-Type':'application/json',authorization:'Bearer '+token},body:raw??JSON.stringify({serverId:id,...body})}));return {status:response.status,body:await response.json()};};
const changes=id=>d.query(sql`SELECT change,name,version_from AS "from",version_to AS "to",architecture,scope FROM device_software_changes WHERE server_id=${id} ORDER BY id`);
const stored=id=>d.query(sql`SELECT key,name,normalized_name AS "normalizedName",version,normalized_version AS "normalizedVersion",architecture FROM device_software WHERE server_id=${id} ORDER BY key`);
const fleet=async(as,params)=>{viewer=as;const response=await fleetApi.GET(new Request('https://sw.test/api/software?'+new URLSearchParams(params)));return {status:response.status,body:await response.json()};};
const deviceView=async(as,id)=>{viewer=as;const response=await deviceApi.GET(new Request('https://sw.test/api/software/device?id='+id));return {status:response.status,body:await response.json()};};
const later=(ms=61000)=>{clock+=ms;};

try{
 // ---- Normalization ----
 check([inventory.normalizeSoftwareName('Google Chrome','120.0.6099.130'),inventory.normalizeSoftwareVersion('120.0.6099.130')],['google chrome','120.0.6099.130'],'Google Chrome');
 check([inventory.normalizeSoftwareName('7-Zip 23.01 (x64)','23.01'),inventory.normalizeSoftwareVersion('23.01')],['7-zip','23.01'],'7-Zip 23.01 (x64)');
 check([inventory.normalizeSoftwareName('  Notepad++   8.6.2  (64-bit) ','8.6.2'),inventory.normalizeSoftwareName('Microsoft Visual C++ 2015-2022 Redistributable (x86) - 14.38.33135','14.38.33135'),inventory.normalizeSoftwareName('Ｔｏｏｌ x86','1')],['notepad++','microsoft visual c++ 2015-2022 redistributable (x86) -','tool'],'spaces, markers, NFKC');
 check([inventory.normalizeSoftwareVersion('v2.4.1-beta'),inventory.normalizeSoftwareVersion('Build 7'),inventory.normalizeSoftwareVersion(null),inventory.normalizeSoftwareVersion('10.')],['2.4.1',null,null,'10'],'normalized versions');
 check(inventory.normalizeSoftwareName('2023','2023'),'2023','a name that equals its version stays');

 // ---- Checksum parity with the agent (NativeSoftwareInventoryTests.cs uses the same fixture) ----
 check(await inventory.softwareChecksum(softwareChecksumItems),softwareChecksumExpected,'the portal checksum equals the agent value');
 check(await inventory.softwareChecksum([...softwareChecksumItems].reverse()),softwareChecksumExpected,'independent of the input order');
 check(readFileSync('agent/v3/NativeSoftwareInventoryTests.cs','utf8').includes(softwareChecksumExpected),true,'the agent self-test checks the same value');

 // ---- Fixture ----
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const parent=await group('Parent',null),child=await group('Child',parent),groupB=await group('B group',null,customerB);
 const dev1=await device('DEV-1',child),dev2=await device('DEV-2',parent),loose=await device('LOOSE',null),devB=await device('DEV-B',groupB,customerB);
 const owner=await persona('owner'),reader=await persona('reader'),noView=await persona('no-view'),technician=await persona('technician'),groupViewer=await persona('group-viewer');
 await grant(owner,await role('Owner',['*']),'global');
 await grant(reader,await role('Reader',['view']),'global');
 await grant(noView,await role('Nothing',['groups.manage']),'devicegroup',groupB);
 await grant(technician,await role('Technician',['view']),'global');
 await grant(groupViewer,await role('Child viewer',['view']),'devicegroup',child);

 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 // ---- Ingest: baseline ----
 const chrome=item('{CHROME}','Google Chrome','120.0.6099.130',{publisher:'Google LLC'}),zip=item('7-Zip','7-Zip 23.01 (x64)','23.01'),edge=item('{EDGE}','Microsoft Edge','129.0.1'),spotify=item('Spotify','Spotify','1.2.3',{architecture:null,scope:'user'});
 let result=await send(dev1,await report([chrome,zip,edge,spotify]));
 check([result.status,result.body],[200,{ok:true,baseline:true,changes:0}],'the first report is a baseline');
 check(await changes(dev1),[],'a baseline records no changes');
 check((await stored(dev1)).find(row=>row.key==='7-Zip'),{key:'7-Zip',name:'7-Zip 23.01 (x64)',normalizedName:'7-zip',version:'23.01',normalizedVersion:'23.01',architecture:'x64'},'stored with normalized columns');
 check((await stored(dev1)).find(row=>row.key==='Spotify').architecture,'','a user entry stores no architecture');
 // 429 within 60 s, also for an identical list.
 check((await send(dev1,await report([chrome,zip,edge,spotify]))).status,429,'a second report within 60 s');
 // Installed, updated, removed and a new product code with the same name.
 later();
 const edgeNew=item('{EDGE}','Microsoft Edge','130.0.2'),zipNewCode=item('{7ZIP-MSI}','7-Zip 24.08 (x64)','24.08'),teams=item('{TEAMS}','Microsoft Teams','24.1');
 result=await send(dev1,await report([chrome,edgeNew,zipNewCode,teams]));
 check([result.status,result.body.changes],[200,4],'four changes');
 check(await changes(dev1),[
  {change:'updated',name:'Microsoft Edge',from:'129.0.1',to:'130.0.2',architecture:'x64',scope:'machine'},
  {change:'updated',name:'7-Zip 24.08 (x64)',from:'23.01',to:'24.08',architecture:'x64',scope:'machine'},
  {change:'installed',name:'Microsoft Teams',from:null,to:'24.1',architecture:'x64',scope:'machine'},
  {change:'removed',name:'Spotify',from:'1.2.3',to:null,architecture:null,scope:'user'},
 ],'same key with another version and a new product code with the same name are updates; new and missing keys');
 // An identical checksum only refreshes reported_at.
 later();
 const before=await d.one(sql`SELECT reported_at FROM device_software_state WHERE server_id=${dev1}`);
 result=await send(dev1,await report([teams,chrome,zipNewCode,edgeNew]));
 check([result.status,result.body],[200,{ok:true,baseline:false,changes:0}],'the same list in another order changes nothing');
 check(Number((await d.one(sql`SELECT reported_at FROM device_software_state WHERE server_id=${dev1}`)).reported_at)>Number(before.reported_at),true,'reported_at moves');
 check((await changes(dev1)).length,4,'no new change rows');
 // A truncated report records no removals.
 later();
 result=await send(dev1,await report([chrome],{count:3}));
 check([result.status,result.body.changes],[200,0],'truncated: the missing entries are not removed');
 check(Number((await d.one(sql`SELECT truncated FROM device_software_state WHERE server_id=${dev1}`)).truncated),1,'the state keeps truncated');

 // ---- Refused reports ----
 later();
 const valid=await report([chrome,teams]);
 check((await send(dev1,{...valid,checksum:'0'.repeat(64)})).body.code,'SOFTWARE_REPORT_INVALID','a checksum that does not match');
 check((await send(dev1,{...valid,count:1})).status,400,'count below the list');
 check((await send(dev1,{...valid,truncated:true})).status,400,'truncated without a larger count');
 check((await send(dev1,await report([chrome,chrome]))).status,400,'a duplicate entry');
 check((await send(dev1,await report([item('X','X','1',{scope:'user'})]))).status,400,'a user entry with an architecture');
 check((await send(dev1,{...valid,items:[{...chrome,path:'C:\\Users\\alice'}]})).status,400,'an unknown key');
 check((await send(dev1,await report(Array.from({length:2001},(_,i)=>item('K'+i,'App '+i,'1'))))).status,400,'more than 2000 items');
 check((await send(dev1,valid,{token:'token-'+dev2})).status,403,'another device token');
 check((await send(dev1,valid,{token:'wrong'})).status,401,'an unknown token');
 check((await send(dev1,valid,{raw:JSON.stringify({serverId:dev1,...valid,padding:'x'.repeat(1048577)})})).status,413,'a body above 1 MiB');
 check((await changes(dev1)).length,4,'refused reports change nothing');

 // ---- Parallel identical reports record once ----
 later();
 const parallel=await report([chrome,teams,item('{NEW}','New tool','1.0')]);
 const outcomes=await Promise.all([send(dev1,parallel),send(dev1,parallel),send(dev1,parallel)]);
 check(outcomes.filter(outcome=>outcome.status===200).length,1,'one parallel report wins');
 check(outcomes.filter(outcome=>outcome.status===429).length,2,'the others meet the 60 s rule after the first commits');
 check((await changes(dev1)).filter(row=>row.name==='New tool').length,1,'the change is recorded once');

 // ---- Heartbeat softwareResync ----
 const state=(await d.one(sql`SELECT checksum FROM device_software_state WHERE server_id=${dev1}`)).checksum;
 check([await softwareLib.softwareResyncNeeded(dev1,state),await softwareLib.softwareResyncNeeded(dev1,'f'.repeat(64)),await softwareLib.softwareResyncNeeded(dev2,'f'.repeat(64)),await softwareLib.softwareResyncNeeded(dev2,null),await softwareLib.softwareResyncNeeded(dev1,undefined)],[false,true,true,false,false],'resync when the checksum differs or no state exists; never without a checksum');
 check(/softwareResync:true/.test(readFileSync('app/api/heartbeat/route.ts','utf8')),true,'the heartbeat answer carries softwareResync');

 // ---- Device view ----
 const view=await deviceView(reader,dev1);
 check([view.status,view.body.state.count,view.body.items.length,view.body.changes.length],[200,3,3,6],'the device view with state, items and changes (Teams came back after the truncated report)');
 check(view.body.changes[0].name,'New tool','changes newest first');
 check(Object.keys(view.body.items[0]).sort(),['architecture','firstSeen','installDate','key','name','normalizedName','normalizedVersion','publisher','scope','version'],'items with the normalized columns and, with the vulnerability check off, no verdict');
 check(view.body.vulnerabilities,{enabled:false,lastSuccessAt:null},'the vulnerability check is off by default');
 check((await deviceView(reader,dev2)).body,{state:null,items:[],changes:[],vulnerabilities:{enabled:false,lastSuccessAt:null}},'a device without a report');
 check((await deviceView(noView,dev1)).status,403,'no view right: 403');

 // ---- Fleet aggregation ----
 later();await send(dev2,await report([item('{CHROME-2}','Google Chrome','120.0.6099.130',{publisher:'Google LLC'}),item('{ZIP}','7-Zip 24.08 (x64)','24.08')]));
 await send(loose,await report([item('{CHROME-OLD}','Google Chrome','109.0.5414.120',{publisher:'Google LLC'})]));
 await send(devB,await report([item('{CHROME-B}','Google Chrome','120.0.6099.130',{publisher:'Google LLC'})]));
 let rows=(await fleet(owner,{scope:'all'})).body;
 const chrome120=rows.rows.find(row=>row.normalizedName==='google chrome'&&row.normalizedVersion==='120.0.6099.130');
 check([chrome120.deviceCount,chrome120.deviceIds,chrome120.name,chrome120.publisher],[3,[dev1,dev2,devB].sort(),'Google Chrome','Google LLC'],'one row per normalized name and version over all devices');
 check(rows.rows[0].deviceCount>=rows.rows.at(-1).deviceCount,true,'sorted by device count');
 check(rows.truncated,false,'not truncated');
 check([rows.vulnerabilities,rows.rows.some(row=>'verdict' in row)],[{enabled:false,lastSuccessAt:null,vulnerableRows:0},false],'with the vulnerability check off: no verdicts');
 rows=(await fleet(owner,{scope:'all',q:'chrome 1'})).body;
 check(rows.rows.map(row=>row.version).sort(),['109.0.5414.120','120.0.6099.130'],'"chrome 1" finds Chrome 1xx');
 rows=(await fleet(owner,{scope:'all',q:'chrome 109'})).body;check(rows.rows.map(row=>row.version),['109.0.5414.120'],'every token must match');
 check((await fleet(owner,{scope:'all',q:'google 24.08'})).body.rows,[],'tokens may match different fields of the same row only');
 check((await fleet(owner,{scope:'all',q:'100%_'})).body.rows,[],'LIKE characters are literal');
 rows=(await fleet(owner,{scope:'unassigned'})).body;check(rows.rows.map(row=>row.deviceIds).flat(),[loose],'unassigned scope');
 // The Ungrouped scope of one customer (#devices/customer/<id>/ungrouped): its devices without a group.
 rows=(await fleet(owner,{scope:`unassigned:${customerA}`})).body;check(rows.rows.map(row=>row.deviceIds).flat(),[loose],'the devices of a customer without a group');
 check((await fleet(owner,{scope:`unassigned:${customerB}`})).body.rows,[],'a customer whose devices are all in groups');
 rows=(await fleet(owner,{scope:`group:${parent}`})).body;check(rows.rows.find(row=>row.normalizedVersion==='120.0.6099.130').deviceIds,[dev1,dev2].sort(),'a group includes its subgroups');
 rows=(await fleet(owner,{scope:`customer:${customerB}`})).body;check(rows.rows.map(row=>row.deviceIds).flat(),[devB],'customer scope');
 rows=(await fleet(groupViewer,{scope:'all'})).body;check([...new Set(rows.rows.flatMap(row=>row.deviceIds))],[dev1],'only the devices the viewer sees');
 check((await fleet(owner,{scope:'group:not-a-guid'})).status,400,'an invalid scope');
 // Customer boundary once a second customer exists.
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 rows=(await fleet(technician,{scope:'all'})).body;
 check(rows.rows.find(row=>row.normalizedVersion==='120.0.6099.130').deviceIds.includes(devB),false,'devices of an unseen customer never count');
 check((await fleet(technician,{scope:`customer:${customerB}`})).status,404,'an unseen customer answers 404');
 check((await fleet(technician,{scope:`unassigned:${customerB}`})).status,404,'so does its Ungrouped scope');
 check((await fleet(technician,{scope:`group:${groupB}`})).status,404,'a group of an unseen customer answers 404');
 check((await deviceView(technician,devB)).status,404,'a device of an unseen customer answers 404');
 // 2000-row cap.
 later();await send(loose,await report(Array.from({length:2000},(_,i)=>item('APP'+String(i).padStart(4,'0'),'Application '+i,'1.0'))));
 rows=(await fleet(owner,{scope:'all'})).body;
 check([rows.rows.length,rows.truncated,rows.total>2000],[2000,true,true],'at most 2000 rows; truncated with the total');

 // ---- Retention through runMaintenance ----
 const day=86400000;
 await d.exec(sql`INSERT INTO device_software_changes(server_id,at,change,name,normalized_name,version_to,scope) VALUES(${dev2},${time-400*day},'installed','Old','old','1','machine')`);
 const result2=await runMaintenance(d,{list:async()=>({objects:[],truncated:false}),delete:async()=>{}},{retention:{auditDays:30,jobDays:30,softwareDays:365},now:time});
 check(result2.softwareChanges,{deleted:1,more:false},'changes older than softwareDays are deleted');
 check((await d.query(sql`SELECT 1 FROM device_software_changes WHERE name='Old'`)).length,0,'the old change is gone');
 const plan=await d.transaction(async tx=>{await tx.exec(sql`SET LOCAL enable_seqscan=off`);return (await tx.query(sql`EXPLAIN ${maintenanceSelections.softwareChanges(time,10)}`)).map(row=>row['QUERY PLAN']).join('\n');});
 check(/idx_device_software_changes_at/.test(plan),true,'the selection scans the index on at');

 // ---- Removing a device empties its software ----
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${dev1}`);
 check([(await stored(dev1)).length,(await changes(dev1)).length,(await d.query(sql`SELECT 1 FROM device_software_state WHERE server_id=${dev1}`)).length],[0,0,0],'the revoke trigger deletes list, changes and state');
 console.log(`PASS software inventory (${checks} checks): normalization, checksum parity, ingest with baseline, changes, truncation, refusals, 429 and parallel reports, resync, device view, fleet scopes, search and boundary, row cap, retention and the revoke trigger.`);
}finally{await d.close();}
