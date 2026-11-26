// The device description against PostgreSQL: the pure validation of
// lib/device-description.ts, POST /api/device-description and GET /api/console
// through the real routes, lib/server/devices/device-description-store.ts, lib/server/identity/access.ts and
// the audit writer. Covers the expected fence, rights from global, group and
// device scope, the customer boundary, audit rows with rollback, the agent
// paths (heartbeat and enrollment never write the column) and device removal.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {validateDeviceDescription,deviceDescriptionLength,deviceDescriptionMax} from '../../lib/device-description.ts';
import {boundaryPhase,everyCustomer} from '../support/customer-separation.mjs';

const uuid=()=>crypto.randomUUID(),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100';
let viewer=null,checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---- Pure validation ----
const emoji='😀';
check(validateDeviceDescription(emoji.repeat(500)),{ok:true,text:emoji.repeat(500)},'500 code points (emoji) are accepted');
check(deviceDescriptionLength(emoji.repeat(500)),500,'an emoji counts as one code point');
check(validateDeviceDescription('a'.repeat(501)).ok,false,'501 code points are refused');
check(validateDeviceDescription(emoji.repeat(501)).problem,'too-long','501 emoji are too long');
check(deviceDescriptionMax,500,'the limit is 500');
check(validateDeviceDescription('line 1\r\nline 2\rline 3'),{ok:true,text:'line 1\nline 2\nline 3'},'CRLF and CR become LF');
check(validateDeviceDescription('  \n Accounting \t\n '),{ok:true,text:'Accounting'},'leading and trailing whitespace is trimmed');
check(validateDeviceDescription(''),{ok:true,text:''},'empty clears the description');
check(validateDeviceDescription('   '),{ok:true,text:''},'whitespace only clears the description');
check(validateDeviceDescription('Room\t2.14'),{ok:true,text:'Room\t2.14'},'TAB is allowed inside');
for(const text of ['<b>x</b>','<script>','<!-- -->','</p>','a<br/>b','<img src=x onerror=1>'])check(validateDeviceDescription(text).problem,'invalid',`HTML is refused: ${text}`);
for(const text of ['a < b','x<5','1 <> 2','<5 users> later','a <- b','unclosed <b'])check(validateDeviceDescription(text),{ok:true,text},`plain text with < is accepted: ${text}`);
for(const character of ['\u0000','\u0007','\u000b','\u001b','\u007f','\u0085'])check(validateDeviceDescription(`a${character}b`).problem,'invalid',`control character U+${character.codePointAt(0).toString(16)} is refused`);
check(validateDeviceDescription(42).ok,false,'a non-string is refused');

const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
const HttpError=realHttpError;
const d=await sourceDatabase(),db=hookDatabase(d);
const server={db:()=>db,now:()=>Date.now(),config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>hash(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
 body:request=>request.json(),sameOrigin:()=>{},requireViewer:async()=>stamped({...viewer}),log:async()=>{},
 failure:error=>error instanceof HttpError?Response.json({error:error.message,code:error.code},{status:error.status}):Response.json({error:String(error?.message??error)},{status:500})};
const mfa={requireLiveSessions:async()=>{},requireMfa:async()=>{},isMfaEnabled:async()=>true,mfaSessionFence:async()=>sql`TRUE`,readMfaManagementProof:async()=>({guard:sql`TRUE`})};
const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../identity/mfa':mfa,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,
 '../agent/agent-protocol':{maintenanceBusy:async()=>false},'@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},
 '@/lib/management':{operations:{},safeTarget:()=>''},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},
 '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
 '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},
 '@/lib/diagnostics':{diagnosticDefinitions:{},diagnosticSecurityAccess:()=>false,isDiagnosticKind:()=>false},'@/lib/file-operations':{fileSecurityAccess:()=>false},
 '@/lib/server/devices/device-lifecycle':{removeDevice:async()=>({}),removeDevices:async()=>({}),sweepRemovedTransfers:async()=>{}},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}},
 './transfers':{clearTransfer:async()=>{}}};
const load=sourceLoader();
const access=load('lib/server/identity/access.ts',imports);
const descriptionApi=load('app/api/device-description/route.ts',imports),consoleApi=load('app/api/console/route.ts',imports);
const {recordHeartbeat}=load('lib/server/agent/heartbeat.ts',imports),{enrollDevice}=load('lib/server/console-data.ts',imports),lifecycle=load('lib/server/devices/device-lifecycle.ts',imports);

const time=Date.now();
const insert=(table,row)=>insertRow(d,table,row);
async function persona(name){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@description.test',display_name:name,auth_principal:principal,auth_email:name+'@description.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@description.test',principal});
}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){const id=uuid();await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${id},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);return id;}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};
async function device(name,groupId,customer=customerA,extra={}){const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:null,management:1,customer_id:customer,...extra});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});return id;}

const post=async(as,body)=>{viewer=as;const response=await descriptionApi.POST(new Request('https://description.test/api/device-description',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
const save=(as,serverId,description,expected)=>post(as,{serverId,description,expected});
const consoleServers=async as=>{viewer=as;const response=await consoleApi.GET(new Request('https://description.test/api/console'));assert.equal(response.status,200,'console GET');return Object.fromEntries((await response.json()).servers.map(s=>[s.id,s]));};
const stored=async id=>(await d.one(sql`SELECT description FROM servers WHERE id=${id}`)).description;
const auditRows=()=>d.query(sql`SELECT action,target,scope,server_id AS "serverId",customer_id AS "customerId" FROM audit WHERE action='device.description.set' ORDER BY id`);
async function refused(promise,status,code,label,id){
 const [before,beforeAudit]=await Promise.all([stored(id),auditRows()]);
 const result=await promise;
 check(result.status,status,label);if(code!==undefined)check(result.body.code,code,label+' code');
 check(await stored(id),before,label+' leaves the description unchanged');check((await auditRows()).length,beforeAudit.length,label+' writes no audit row');
 return result;
}

try{
 // ---- Fixture ----
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const parent=await group('Parent',null),child=await group('Child',parent),groupB=await group('B group',null,customerB);
 const dev1=await device('DEV-1',child),dev2=await device('DEV-2',parent),loose=await device('LOOSE',null),devB=await device('DEV-B',groupB,customerB);
 const owner=await persona('owner'),operator=await persona('operator'),globalManager=await persona('global-manager'),parentManager=await persona('parent-manager'),deviceManager=await persona('device-manager'),technician=await persona('technician');
 await grant(owner,await role('Owner',['*']),'global');
 await grant(operator,await role('Operator',access.rolePermissions.operator),'global');
 await grant(globalManager,await role('Groups everywhere',['view','groups.manage']),'global');
 const parentAssignment=await grant(parentManager,await role('Groups on parent',['view','groups.manage']),'devicegroup',parent);
 await grant(deviceManager,await role('Groups on device',['view','groups.manage']),'device',dev2);await grant(deviceManager,await role('View all',['view']),'global');
 await grant(technician,await role('Technician',['view','groups.manage']),'global');
 check(access.rolePermissions.operator.includes('groups.manage'),false,'Operator lacks groups.manage');

 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 // ---- Migration default and console ----
 let servers=await consoleServers(owner);
 check([servers[dev1].description,servers[dev2].description,servers[loose].description],['','',''],'existing rows read as empty');
 check(Object.values(servers).every(s=>typeof s.description==='string'),true,'every server has a description string');

 // ---- Save and read back ----
 let result=await save(globalManager,dev1,'  Accounting\r\nroom 2.14  ','');
 check([result.status,result.body],[200,{ok:true,description:'Accounting\nroom 2.14'}],'save stores the normalized text and returns it');
 servers=await consoleServers(owner);check(servers[dev1].description,'Accounting\nroom 2.14','GET /api/console returns the stored text');
 const rows=await auditRows();
 check(rows.length,1,'one audit row');
 check([rows[0].scope,rows[0].serverId,rows[0].customerId,JSON.parse(rows[0].target)],['device',dev1,customerA,{old:'',new:'Accounting\nroom 2.14'}],'device audit row with old and new');
 result=await save(globalManager,dev1,'Accounting\nroom 2.14','Accounting\nroom 2.14');
 check([result.status,result.body.description,(await auditRows()).length],[200,'Accounting\nroom 2.14',1],'saving the stored text writes no row and answers 200');

 // ---- Expected fence ----
 await refused(save(globalManager,dev1,'Other','stale text'),409,'DEVICE_DESCRIPTION_CHANGED','stale expected',dev1);
 await refused(save(globalManager,dev1,'Other',''),409,'DEVICE_DESCRIPTION_CHANGED','expected empty while text exists',dev1);
 db.beforeNextTransaction(()=>d.exec(sql`UPDATE servers SET description='changed meanwhile' WHERE id=${dev1}`));
 result=await save(globalManager,dev1,'Mine','Accounting\nroom 2.14');check([result.status,result.body.code],[409,'DEVICE_DESCRIPTION_CHANGED'],'a change between check and commit fails the fence');
 check(await stored(dev1),'changed meanwhile','the concurrent text stays');

 // ---- Validation ----
 await refused(save(globalManager,dev1,'<b>x</b>','changed meanwhile'),400,'DEVICE_DESCRIPTION_INVALID','HTML',dev1);
 await refused(save(globalManager,dev1,'a'.repeat(501),'changed meanwhile'),400,'DEVICE_DESCRIPTION_INVALID','too long',dev1);
 await refused(save(globalManager,dev1,'a\u0007b','changed meanwhile'),400,'DEVICE_DESCRIPTION_INVALID','control character',dev1);
 await refused(save(globalManager,dev1,42,'changed meanwhile'),400,'DEVICE_DESCRIPTION_INVALID','not a string',dev1);
 await refused(save(globalManager,dev1,'ok',null),400,'DEVICE_DESCRIPTION_INVALID','expected missing',dev1);
 check((await save(globalManager,'not-a-guid','x','')).status,400,'invalid device id');

 // ---- Rights ----
 result=await save(parentManager,dev1,'From the parent group right','changed meanwhile');check(result.status,200,'right on an ancestor group allows a device in a child group');
 result=await save(deviceManager,dev2,'From the device right','');check(result.status,200,'right on the device itself');
 await refused(save(deviceManager,dev1,'No','From the parent group right'),403,undefined,'a right on another device does not allow this one',dev1);
 await refused(save(parentManager,loose,'No',''),403,undefined,'a group right does not reach an ungrouped device',loose);
 await refused(save(operator,dev2,'No','From the device right'),403,undefined,'Operator (no groups.manage) gets 403',dev2);
 result=await save(owner,loose,'Owner text','');check(result.status,200,'Owner allowed');
 // A right lost between check and commit.
 db.beforeNextTransaction(()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${parentAssignment}`));
 await refused(save(parentManager,dev1,'Too late','From the parent group right'),403,undefined,'right lost before the commit',dev1);
 // An unknown device.
 check((await save(owner,uuid(),'x','')).status,404,'unknown device answers 404');

 // ---- Audit failure rolls the change back ----
 await createTrigger(d,'description_audit_fails','audit','BEFORE INSERT',{message:'audit-down',when:"NEW.action='device.description.set'"});
 result=await save(globalManager,dev1,'Never stored','From the parent group right');check(result.status,500,'audit failure fails the request');
 check(await stored(dev1),'From the parent group right','audit failure leaves the description unchanged');
 await dropTrigger(d,'description_audit_fails');

 // ---- Agent paths never write the description ----
 const token='b'.repeat(64),tokenHash=hash(token),agentDevice=await device('AGENT',null,customerA,{token_hash:tokenHash,token_expires_at:time+86400000,description:'Kept by the portal'});
 const changedRows=await recordHeartbeat({serverId:agentDevice,tokenHash,time:Date.now(),publicKey:'fixture-key',cpu:5,memory:10,gpus:null,snapshot:JSON.stringify({hostname:'AGENT'}),management:true,capabilities:[],runningJobs:[],description:'Set by the agent'});
 check(changedRows,true,'the heartbeat was stored');
 check(await stored(agentDevice),'Kept by the portal','a heartbeat with a description field leaves the column unchanged');
 const enrolled=uuid();
 await enrollDevice({id:enrolled,name:'NEW',tokenHash:hash('enroll'),createdAt:time,expiresAt:time+86400000,groupId:null,customerId:customerA,description:'Set by enrollment'},sql`TRUE`,null);
 check(await stored(enrolled),'','enrollment stores an empty description even with a description field');
 for(const file of ['lib/server/agent/heartbeat.ts','app/api/heartbeat/route.ts'])check(/description/.test(readFileSync(file,'utf8')),false,`${file} never names the description`);
 const enrollment=readFileSync('lib/server/console-data.ts','utf8').match(/export async function enrollDevice[\s\S]*?\n}\n/)[0];
 check(/description/.test(enrollment),false,'enrollDevice never names the description');

 // ---- Revoked device and device removal ----
 const proof=async actor=>{const tokenHash=hash(uuid()),sessionHash=hash(actor.id+'mfa');await d.exec(sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${tokenHash},${access.principal(actor)},${sessionHash},${Date.now()+300_000})`);const key=access.principal(actor);return {tokenHash,key,sessionHash,guard:sql`EXISTS (SELECT 1 FROM mfa_management_proofs WHERE token_hash=${tokenHash} AND principal=${key} AND session_hash=${sessionHash} AND expires_at>${Date.now()})`};};
 check(await stored(dev2),'From the device right','the device has a description before removal');
 const removal=await lifecycle.removeDevices(owner,[dev2],true,await proof(owner));
 check(removal.removedCount,1,'the device is removed');
 check(await stored(dev2),'','removal clears the description in the revoking statement');
 await refused(save(owner,dev2,'Back again',''),404,undefined,'a revoked device answers 404',dev2);

 // ---- Customer boundary once a second customer exists ----
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 await refused(save(technician,devB,'Other customer',''),404,undefined,'a device of another customer answers 404',devB);
 result=await save(technician,loose,'Customer A text','Owner text');check(result.status,200,'technician changes a device of customer A');
 console.log(`PASS device description (${checks} checks): validation, save and console read, expected fence, rights from global, group and device scope, Operator, unknown, revoked and other-customer devices, audit with no-op and rollback, agent paths and removal.`);
}finally{await d.close();}
