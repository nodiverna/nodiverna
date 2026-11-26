// Drivers and Device Manager errors on PostgreSQL: the strict snapshot and report
// schemas, deviceProblemText in English and German, the checksum parity with the
// agent, POST /api/agent/drivers (replace, identical checksum, mismatch, 429,
// device token, body limit, parallel reports), driverResync, GET
// /api/drivers/device and GET /api/drivers (scopes, search, customer boundary,
// 2000-row cap), the rules device-problem and driver-unsigned with their texts,
// the crash link target and the revoke trigger.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {driverChecksumItems,driverChecksumExpected} from '../support/driver-checksum-fixture.mjs';
import {sql} from '../../runtime/database.mjs';
import '../support/register.mjs';
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
 failure:error=>error instanceof HttpError?Response.json({error:error.message,code:error.code,messageKey:error.messageKey},{status:error.status}):Response.json({error:String(error?.message??error)},{status:500})};
const tokens=new Map();
const v3={agentFromBearer:async request=>{const token=(request.headers.get('authorization')??'').replace(/^Bearer /,'');const id=tokens.get(token);if(!id)throw new HttpError(401,'Agent nicht freigegeben.');return {id};}};
const imports={'../context':server,'../../context':server,'@/lib/server/context':server,'@/lib/server/agent/agent-protocol':v3,'./agent-protocol':v3,'../agent/agent-protocol':v3};
const load=sourceLoader();
const inventory=load('lib/driver-inventory.ts',imports),driversLib=load('lib/server/devices/drivers.ts',imports);
const agentApi=load('app/api/agent/drivers/route.ts',imports),fleetApi=load('app/api/drivers/route.ts',imports),deviceApi=load('app/api/drivers/device/route.ts',imports);
const {telemetry}=await import('../../lib/server/agent/telemetry.ts');
const {deviceProblemText}=await import('../../ui/base/device-problem-codes.ts');
const {defaultAlertSettings,evaluateAlertRules}=await import('../../lib/alert-rules.ts');
const {deviceIssues,issueTarget}=await import('../../ui/base/ui-device.ts');

const time=Date.now(),insert=(table,row)=>insertRow(d,table,row);
async function persona(name){const id=uuid(),principal='local:'+id;await insert('local_users',{id,username:name,email:name+'@drv.test',display_name:name,auth_principal:principal,auth_email:name+'@drv.test',status:'active',auth_version:1,created_at:time,updated_at:time});return stamped({id,userId:id,label:name+'@drv.test',principal});}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};
async function device(name,groupId,customer=customerA){const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:0,snapshot:null,customer_id:customer});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});tokens.set('token-'+id,id);return id;}

const key=text=>crypto.createHash('sha256').update(text).digest('hex').slice(0,16);
const item=(name,inf,version,extra={})=>({key:key(name+inf+version+(extra.salt??'')),deviceName:name,deviceClass:'System',infName:inf,file:null,service:null,provider:'Contoso',version,date:'2024-03-01',signed:true,signer:'Microsoft Windows',...Object.fromEntries(Object.entries(extra).filter(([name])=>name!=='salt'))});
const report=async(items,{count=items.length,truncated=count>items.length,checksum}={})=>({checksum:checksum??await inventory.driverChecksum(items),count,truncated,items});
const send=async(id,body,{token='token-'+id,raw}={})=>{const response=await agentApi.POST(new Request('https://drv.test/api/agent/drivers',{method:'POST',headers:{'Content-Type':'application/json',authorization:'Bearer '+token},body:raw??JSON.stringify({serverId:id,...body})}));return {status:response.status,body:await response.json()};};
const stored=id=>d.query(sql`SELECT key,device_name AS "deviceName",inf_name AS "infName",file,version,signed FROM device_drivers WHERE server_id=${id} ORDER BY key`);
const state=id=>d.one(sql`SELECT checksum,reported_at AS "reportedAt",count,truncated=1 AS truncated FROM device_driver_state WHERE server_id=${id}`);
const fleet=async(as,params)=>{viewer=as;const response=await fleetApi.GET(new Request('https://drv.test/api/drivers?'+new URLSearchParams(params)));return {status:response.status,body:await response.json()};};
const deviceView=async(as,id)=>{viewer=as;const response=await deviceApi.GET(new Request('https://drv.test/api/drivers/device?id='+id));return {status:response.status,body:await response.json()};};
const later=(ms=61000)=>{clock+=ms;};

try{
 // ---- Snapshot and report schemas ----
 const base={hostname:'H',os:'Windows 11 Pro',build:'26100',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.11.0',mode:'ReadOnly',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:[]};
 const health=(extra={})=>({collectedAt:new Date(time).toISOString(),checksum:'a'.repeat(64),count:120,truncated:false,unsignedCount:1,unsigned:[{key:key('vjoy'),deviceName:'vJoy Device',infName:'oem42.inf',file:'vjoy.sys',provider:'Shaul Eizikovich',version:'2.1.9.1'}],problems:[{key:key('p1'),name:'Unknown USB Device',class:'USB',code:43,manufacturer:null},{key:key('p2'),name:'PCI Data Acquisition',class:null,code:28,manufacturer:null}],problemsTruncated:false,...extra});
 check(telemetry.safeParse({...base,driverHealth:health()}).success,true,'a valid driverHealth');
 for(const [label,value] of [
  ['a PNPDeviceID',health({problems:[{key:key('p1'),name:'X',class:null,code:43,manufacturer:null,pnpDeviceId:'USB\\VID_1234'}]})],
  ['an unknown key',health({deviceIds:[]})],
  ['a key that is no hash',health({problems:[{key:'USB\\VID_1234',name:'X',class:null,code:43,manufacturer:null}]})],
  ['a file with a path',health({unsigned:[{key:key('v'),deviceName:'X',infName:null,file:'C:\\Windows\\vjoy.sys',provider:null,version:null}]})],
  ['code 0',health({problems:[{key:key('p1'),name:'X',class:null,code:0,manufacturer:null}]})],
  ['more unsigned items than unsignedCount',health({unsignedCount:0})],
  ['more than 20 unsigned items',health({unsignedCount:21,unsigned:Array.from({length:21},(_,i)=>({key:key('u'+i),deviceName:'X',infName:null,file:null,provider:null,version:null}))})],
 ])check(telemetry.safeParse({...base,driverHealth:value}).success,false,`rejects ${label}`);
 check(inventory.driverReport.safeParse(await report([item('X','oem1.inf','1',{deviceId:'PCI\\VEN'})])).success,false,'the report rejects a device ID');
 check(inventory.driverReport.safeParse(await report([item('X','oem1.inf','1',{date:'03/01/2024'})])).success,false,'the report rejects a date that is not YYYY-MM-DD');

 // ---- deviceProblemText ----
 check([1,10,28,43,56,99].map(code=>deviceProblemText(code,'en')),['Code 1: This device is not configured correctly.','Code 10: This device cannot start.','Code 28: The drivers for this device are not installed.','Code 43: Windows has stopped this device because it has reported problems.',deviceProblemText(56,'en'),'Code 99: Unknown problem.'],'problem texts (en)');
 assert.match(deviceProblemText(56,'en'),/^Code 56: \S/,'code 56 has a text');checks++;
 check([deviceProblemText(28,'de'),deviceProblemText(22,'de'),deviceProblemText(99,'de')],['Code 28: Die Treiber für dieses Gerät sind nicht installiert.','Code 22: Das Gerät ist deaktiviert.','Code 99: Unbekanntes Problem.'],'problem texts (de)');
 for(let code=1;code<=56;code++){assert.doesNotMatch(deviceProblemText(code,'en'),/Unknown problem/,`code ${code} is documented`);assert.doesNotMatch(deviceProblemText(code,'de'),/Unbekanntes Problem/,`code ${code} is documented (de)`);}checks++;

 // ---- Checksum parity with the agent ----
 check(await inventory.driverChecksum(driverChecksumItems),driverChecksumExpected,'the portal checksum equals the agent value');
 check(await inventory.driverChecksum([...driverChecksumItems].reverse()),driverChecksumExpected,'independent of the input order');
 check(readFileSync('agent/v3/NativeDriverInventoryTests.cs','utf8').includes(driverChecksumExpected),true,'the agent self-test checks the same value');

 // ---- Fixture ----
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const parent=await group('Parent',null),child=await group('Child',parent),groupB=await group('B group',null,customerB);
 const dev1=await device('DEV-1',child),dev2=await device('DEV-2',parent),loose=await device('LOOSE',null),devB=await device('DEV-B',groupB,customerB);
 const owner=await persona('owner'),noView=await persona('no-view'),technician=await persona('technician'),groupViewer=await persona('group-viewer');
 await grant(owner,await role('Owner',['*']),'global');
 await grant(noView,await role('Nothing',['groups.manage']),'devicegroup',groupB);
 await grant(technician,await role('Technician',['view']),'global');
 await grant(groupViewer,await role('Child viewer',['view']),'devicegroup',child);

 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 // ---- Ingest ----
 const vjoy=item('vJoy Device','oem42.inf','2.1.9.1',{file:'vjoy.sys',service:'vjoy',signed:false,signer:null,provider:'Shaul Eizikovich',date:'2019-08-01'});
 const nic=item('Intel Ethernet','oem7.inf','12.19.2.45',{provider:'Intel',deviceClass:'Net'});
 const gpu=item('NVIDIA RTX','oem9.inf','31.0.15.5222',{provider:'NVIDIA',deviceClass:'Display'});
 const first=await report([vjoy,nic]);
 check(await driversLib.driverResyncNeeded(dev1,first.checksum),true,'resync while the portal has no state');
 check((await send(dev1,first)).body,{ok:true,changed:true},'the first report is stored');
 check((await stored(dev1)).map(row=>row.deviceName).sort(),['Intel Ethernet','vJoy Device'],'both drivers stored');
 check(await state(dev1),{checksum:first.checksum,reportedAt:clock,count:2,truncated:false},'state with checksum, time and count');
 {const early=await send(dev1,await report([vjoy,nic,gpu]));check([early.status,early.body.code,early.body.messageKey],[429,'RATE_LIMITED','apiError.drivers.tooSoon'],'a second report within 60 s');}
 later();const second=await report([vjoy,gpu]);
 check((await send(dev1,second)).body,{ok:true,changed:true},'a changed report replaces the list');
 check((await stored(dev1)).map(row=>row.deviceName).sort(),['NVIDIA RTX','vJoy Device'],'no change history: removed rows are gone');
 later();check((await send(dev1,second)).body,{ok:true,changed:false},'an identical checksum changes nothing');
 check((await state(dev1)).reportedAt,clock,'and refreshes reported_at');
 check([await driversLib.driverResyncNeeded(dev1,second.checksum),await driversLib.driverResyncNeeded(dev1,'f'.repeat(64)),await driversLib.driverResyncNeeded(dev1,undefined),await driversLib.driverResyncNeeded(dev1,null)],[false,true,false,false],'driverResync only for a different checksum');
 check(/driverResync:true/.test(readFileSync('app/api/heartbeat/route.ts','utf8')),true,'the heartbeat answer carries driverResync');
 // Refusals.
 later();const valid=await report([vjoy]);
 const mismatch=await send(dev1,{...valid,checksum:'0'.repeat(64)});
 check([mismatch.status,mismatch.body.code,mismatch.body.messageKey],[400,'DRIVER_REPORT_INVALID','apiError.drivers.reportInvalid'],'a checksum mismatch answers 400 DRIVER_REPORT_INVALID');
 check((await send(dev1,await report(Array.from({length:2001},(_,i)=>item('D'+i,'oem.inf','1'))))).status,400,'more than 2000 items');
 check((await send(dev1,valid,{token:'token-'+dev2})).status,403,'another device token');
 check((await send(dev1,valid,{token:'unknown'})).status,401,'an unknown token');
 check((await send(dev1,valid,{raw:JSON.stringify({serverId:dev1,...valid,padding:'x'.repeat(1048577)})})).status,413,'a body above 1 MiB');
 check((await stored(dev1)).length,2,'no refused report changed the list');
 // Truncated report.
 check((await send(dev2,await report([nic],{count:2500,truncated:true}))).body.ok,true,'a truncated report is accepted');
 check(await state(dev2),{checksum:(await report([nic])).checksum,reportedAt:clock,count:2500,truncated:true},'count and truncated are stored');
 // Parallel reports.
 later();const parallel=await report([vjoy,nic,gpu]);
 const outcomes=await Promise.all([send(dev1,parallel),send(dev1,parallel),send(dev1,parallel)]);
 check(outcomes.filter(outcome=>outcome.status===200).length,1,'one parallel report wins');
 check(outcomes.filter(outcome=>outcome.status===429).length,2,'the others meet the 60 s rule');
 check((await stored(dev1)).length,3,'the list is stored once');

 // ---- Device view ----
 const view=await deviceView(owner,dev1);
 check([view.status,view.body.state.count,view.body.items.length],[200,3,3],'the device view');
 check(view.body.items.find(row=>row.infName==='oem42.inf').file,'vjoy.sys','with the driver file');
 check((await deviceView(owner,loose)).body,{state:null,items:[]},'a device without a report');
 check((await deviceView(noView,dev1)).status,403,'no view right: 403');
 check((await deviceView(groupViewer,dev2)).status,403,'a device outside the viewer group: 403');

 // ---- Fleet aggregation ----
 later();await send(loose,await report([item('Intel Ethernet 2','oem7.inf','12.19.2.45',{provider:'Intel',deviceClass:'Net'})]));
 later();await send(devB,await report([nic]));
 let rows=(await fleet(owner,{scope:'all'})).body;
 const intel=rows.rows.find(row=>row.driver==='oem7.inf'&&row.version==='12.19.2.45');
 check([intel.deviceCount,intel.deviceIds.sort()],[4,[dev1,dev2,loose,devB].sort()],'grouped by INF, version and provider over all devices');
 check(rows.rows[0].deviceCount>=rows.rows.at(-1).deviceCount,true,'device count descending');
 check((await fleet(owner,{scope:'all',q:'vjoy'})).body.rows.map(row=>row.driver),['oem42.inf'],'search matches the file name');
 check((await fleet(owner,{scope:'all',q:'intel 12.19'})).body.rows.map(row=>row.driver),['oem7.inf'],'search tokens over provider and version');
 check((await fleet(owner,{scope:'unassigned'})).body.rows.flatMap(row=>row.deviceIds),[loose],'unassigned scope');
 check([...new Set((await fleet(owner,{scope:`group:${parent}`})).body.rows.flatMap(row=>row.deviceIds))].sort(),[dev1,dev2].sort(),'a group scope includes its subgroups');
 check((await fleet(owner,{scope:`customer:${customerB}`})).body.rows.flatMap(row=>row.deviceIds),[devB],'customer scope');
 check([...new Set((await fleet(groupViewer,{scope:'all'})).body.rows.flatMap(row=>row.deviceIds))],[dev1],'only the devices the viewer sees');
 check((await fleet(owner,{scope:'group:not-a-guid'})).status,400,'an invalid scope');
 // Customer boundary once a second customer exists.
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 rows=(await fleet(technician,{scope:'all'})).body;
 check(rows.rows.some(row=>row.deviceIds.includes(devB)),false,'devices of an unseen customer never count');
 check(rows.rows.find(row=>row.driver==='oem7.inf'&&row.version==='12.19.2.45').deviceCount,3,'and do not change the count');
 check((await fleet(technician,{scope:`customer:${customerB}`})).status,404,'an unseen customer answers 404');
 check((await fleet(technician,{scope:`group:${groupB}`})).status,404,'a group of an unseen customer answers 404');
 check((await deviceView(technician,devB)).status,404,'a device of an unseen customer answers 404');
 // 2000-row cap.
 later();await send(loose,await report(Array.from({length:2000},(_,i)=>item('Device '+i,`oem${i}.inf`,'1.0'))));
 rows=(await fleet(owner,{scope:'all'})).body;
 check([rows.rows.length,rows.truncated,rows.total>2000],[2000,true,true],'at most 2000 rows; truncated with the total');

 // ---- Rules, texts and the crash link ----
 const now=time,evaluated=snapshot=>{const item={id:'d',name:'D',createdAt:0,revoked:0,management:0,lastSeen:now,snapshot:{...base,...snapshot}};return {...item,issues:evaluateAlertRules(item,defaultAlertSettings(),now)};};
 const driverIssues=snapshot=>evaluated(snapshot).issues.filter(issue=>issue.ruleId==='device-problem'||issue.ruleId==='driver-unsigned');
 check(driverIssues({driverHealth:health()}).map(issue=>[issue.key,issue.level]),[['device-problem','warning'],['driver-unsigned','info']],'device-problem warning, driver-unsigned info');
 check(driverIssues({driverHealth:health({problems:[],unsignedCount:0,unsigned:[]})}),[],'no problem and no unsigned driver: no issue');
 check(driverIssues({}),[],'an older agent: no issue');
 const texts=(snapshot,locale)=>deviceIssues(evaluated(snapshot),now,locale).filter(issue=>issue.key==='device-problem'||issue.key==='driver-unsigned').map(issue=>[issue.title,issue.detail]);
 check(texts({driverHealth:health()},'en'),[['2 devices with errors in Device Manager','Unknown USB Device: Code 43: Windows has stopped this device because it has reported problems. +1 more'],['1 unsigned driver','oem42.inf']],'texts (en)');
 check(texts({driverHealth:health({problems:health().problems.slice(1)})},'de')[0],['1 Gerät mit Fehler im Geräte-Manager','PCI Data Acquisition: Code 28: Die Treiber für dieses Gerät sind nicht installiert.'],'one problem (de)');
 const crash={id:'c1',kind:'bugcheck',at:new Date(now-3600000).toISOString(),stopCode:209,parameters:null,driver:{name:'vjoy.sys',version:null,manufacturer:null},source:'event+minidump',dumpFile:null,dumpStatus:'parsed',detail:null};
 const crashIssue=snapshot=>evaluated({crashes:[crash],crashInventory:{collectedAt:new Date(now).toISOString(),windowDays:30,complete:true,truncated:false},...snapshot}).issues.find(issue=>issue.ruleId==='crash-recent');
 check(issueTarget(crashIssue({driverHealth:health()}),{snapshot:{driverHealth:health()}}),{section:'software',software:'drivers',driver:'vjoy.sys'},'a crash with a driver links to the driver inventory');
 check(issueTarget(crashIssue({}),{snapshot:{}}),{section:'diagnostics',diagnosis:'events'},'without driverHealth (older agent) the crash opens Events');

 // ---- Removing a device empties its drivers ----
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${dev1}`);
 check([(await stored(dev1)).length,await state(dev1)],[0,null],'the revoke trigger deletes list and state');
 console.log(`PASS driver inventory (${checks} checks): schemas without device IDs, problem texts 1-56 in en/de, checksum parity, ingest replace, identical checksum, refusals, 429 and parallel reports, driverResync, device view, fleet scopes, search, boundary and row cap, rules, texts, crash link and the revoke trigger.`);
}finally{await d.close();}
