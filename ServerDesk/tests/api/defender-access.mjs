// Microsoft Defender rights and data boundary against PostgreSQL (agent 4.14.0):
// the built-in role lists after a fresh seed and after drizzle/0014_defender_rights.sql
// (idempotent, custom and customer roles unchanged), GET /api/console with and
// without defender.read (also with diagnose), the customer boundary with several customers
// for a global Reader and for a customer role, and issue params without names,
// paths or users. Real routes, lib/server/identity/access.ts and lib/server/identity/rbac.ts.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {boundaryPhase,everyCustomer} from '../support/customer-separation.mjs';

const uuid=()=>crypto.randomUUID(),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100';
let viewer=null,checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
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
 '../devices/transfers':{clearTransfer:async()=>{}},'./transfers':{clearTransfer:async()=>{}}};
const load=sourceLoader();
const rbac=load('lib/server/identity/rbac.ts',imports);
const consoleApi=load('app/api/console/route.ts',imports);
// 0014 is one statement without parameters, so it runs as a plain fragment
// (the multi-statement runner belongs to scripts/selfhost.mjs only, tests/lib/database-layer.mjs).
const migrationText=readFileSync('drizzle/0014_defender_rights.sql','utf8'),migrationStrings=Object.assign([migrationText],{raw:[migrationText]});
const runMigration=()=>d.exec(sql(migrationStrings));

const time=Date.now(),insert=(table,row)=>insertRow(d,table,row);
async function persona(name){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@defender.test',display_name:name,auth_principal:principal,auth_email:name+'@defender.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@defender.test',principal});
}
async function role(name,permissions,customer=null){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time,customer_id:customer});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);}
const assign=async(user,customer)=>d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customer},'user',${user.id},${time},'fixture')`);
const group=async(name,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:null,customer_id:customer});return id;};
const iso=offset=>new Date(time-offset).toISOString();
const defender={available:true,collectedAt:iso(60000),mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,quickScanAt:iso(3600000),fullScanAt:null,signatureAt:iso(3600000),signatureVersion:'1.421.1868.0',productVersion:'4.18.24090.11',
 otherAntivirus:null,detectionCount:1,activeCount:1,highestActiveSeverity:'severe',truncated:false,
 detections:[{id:'{A}',threatId:'2147519003',name:'Trojan:Win32/Secretname',severity:'severe',status:'detected',active:true,path:'C:\\Users\\anna\\Downloads\\secretfile.exe',resourceCount:1,at:iso(3600000),user:'CONTOSO\\annauser'}],
 exclusions:{paths:['D:\\HiddenExclusion'],extensions:['.hiddenext'],processes:['hiddenproc.exe']}};
const snapshot={hostname:'H',os:'Microsoft Windows Server 2025 Datacenter',build:'26100',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,
 disks:[],services:[],processes:[{name:'svchost',pid:4,memoryMb:10,cpuSeconds:1,user:'SYSTEM',path:'C:\\Windows\\System32\\svchost.exe'}],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.14.0',mode:'ReadOnly',agentCapabilities:['defender-status'],defender};
async function device(name,groupId,customer=customerA){const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:0,customer_id:customer,snapshot:JSON.stringify(snapshot)});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});return id;}
const consoleAnswer=async as=>{viewer=as;const response=await consoleApi.GET(new Request('https://defender.test/api/console'));assert.equal(response.status,200,'console GET');return response.json();};
const consoleServers=async as=>Object.fromEntries((await consoleAnswer(as)).servers.map(s=>[s.id,s]));
const lists=s=>[!!s.snapshot.defender.detections,!!s.snapshot.defender.exclusions];
const secrets=['Secretname','secretfile','annauser','HiddenExclusion','hiddenext','hiddenproc'];

try{
 // ---- Built-in roles: fresh seed and migration 0014 ----
 const defenderRights=list=>JSON.parse(list).filter(right=>right.startsWith('defender.'));
 await d.exec(sql`DELETE FROM rbac_roles WHERE builtin=1`);
 await rbac.ensureBuiltinRoles();
 const fresh=Object.fromEntries((await d.query(sql`SELECT id,permissions FROM rbac_roles WHERE builtin=1 ORDER BY id`)).map(row=>[row.id,row.permissions]));
 check(Object.fromEntries(Object.entries(fresh).map(([id,list])=>[id,defenderRights(list)])),{'builtin-device-administrator':['defender.read','defender.control'],'builtin-operator':['defender.read','defender.control'],'builtin-owner':[],'builtin-portal-operator':[],'builtin-reader':['defender.read'],'builtin-user-access-administrator':[]},'a fresh seed: Reader defender.read, Operator and Device Administrator both, the others neither');
 // The rows an older release seeded: the same lists without the Defender rights and without the server role
 // rights that the later migration 0019_agent_plugins.sql appends after them.
 const later=['plugins.manage','dhcp.read','dhcp.manage','dns.read','dns.manage'];
 const withoutLater=list=>JSON.stringify(JSON.parse(list).filter(right=>!later.includes(right)));
 const old=list=>JSON.stringify(JSON.parse(withoutLater(list)).filter(right=>!right.startsWith('defender.')));
 const expected=Object.fromEntries(Object.entries(fresh).map(([id,list])=>[id,withoutLater(list)]));
 for(const [id,list] of Object.entries(fresh))await d.exec(sql`UPDATE rbac_roles SET permissions=${old(list)} WHERE id=${id}`);
 const customRead=await role('Custom reader',JSON.parse(old(fresh['builtin-reader']))),customerRole=await role('Customer operator',JSON.parse(old(fresh['builtin-operator'])),customerA);
 const untouched=async()=>(await d.query(sql`SELECT id,permissions FROM rbac_roles WHERE id IN (${customRead},${customerRole}) ORDER BY id`)).map(row=>row.permissions);
 const before=await untouched();
 await runMigration();
 const migrated=Object.fromEntries((await d.query(sql`SELECT id,permissions FROM rbac_roles WHERE builtin=1 ORDER BY id`)).map(row=>[row.id,row.permissions]));
 check(migrated,expected,'a migrated database gives the same stored lists as a fresh seed up to this migration');
 await runMigration();
 check(Object.fromEntries((await d.query(sql`SELECT id,permissions FROM rbac_roles WHERE builtin=1 ORDER BY id`)).map(row=>[row.id,row.permissions])),expected,'a second run changes nothing and adds no duplicate');
 check(await untouched(),before,'custom and customer roles stay unchanged');
 await d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(['view','defender.read'])} WHERE id='builtin-operator'`);
 await runMigration();
 check(JSON.parse((await d.one(sql`SELECT permissions FROM rbac_roles WHERE id='builtin-operator'`)).permissions),['view','defender.read','defender.control'],'a row with one of the rights gets only the missing one');
 await d.exec(sql`UPDATE rbac_roles SET permissions=${fresh['builtin-operator']} WHERE id='builtin-operator'`);
 await d.exec(sql`DELETE FROM rbac_roles WHERE id IN (${customRead},${customerRole})`);

 // ---- Fixtures ----
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const groupA=await group('A group'),groupB=await group('B group',customerB);
 const devA1=await device('DEV-A1',groupA),devA2=await device('DEV-A2',null),devB=await device('DEV-B',groupB,customerB);
 const owner=await persona('owner'),reader=await persona('reader'),viewOnly=await persona('view-only'),diagnoser=await persona('diagnoser'),customerTech=await persona('customer-tech');
 await grant(owner,'builtin-owner','global');
 await grant(reader,'builtin-reader','global');
 await grant(viewOnly,await role('View only',['view']),'global');
 await grant(diagnoser,await role('Diagnose',['view','diagnose']),'global');
 await grant(customerTech,await role('View everywhere',['view']),'global');
 const technicianRole=await role('Defender on A',['view','defender.read'],customerA);
 await grant(customerTech,technicianRole,'devicegroup',groupA);

 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 // ---- Console GET while only the default customer exists ----
 let servers=await consoleServers(owner);
 check([devA1,devA2,devB].map(id=>lists(servers[id])),[[true,true],[true,true],[true,true]],'the Owner gets detections and exclusions');
 check(servers[devA1].snapshot.defender.detections[0].path,'C:\\Users\\anna\\Downloads\\secretfile.exe','with the path');
 servers=await consoleServers(reader);
 check([devA1,devB].map(id=>lists(servers[id])),[[true,true],[true,true]],'Reader has defender.read');
 for(const as of [viewOnly,diagnoser]){
  const answer=await consoleAnswer(as);servers=Object.fromEntries(answer.servers.map(s=>[s.id,s]));
  check(lists(servers[devA1]),[false,false],`${as.label}: no detections and exclusions without defender.read`);
  const summary=servers[devA1].snapshot.defender;
  check([summary.mode,summary.antivirusEnabled,summary.quickScanAt,summary.signatureVersion,summary.otherAntivirus,summary.detectionCount,summary.activeCount,summary.highestActiveSeverity,summary.truncated],['normal',true,defender.quickScanAt,'1.421.1868.0',null,1,1,'severe',false],`${as.label}: the summary stays`);
  const text=JSON.stringify(answer);
  for(const secret of secrets)check(text.includes(secret),false,`${as.label}: ${secret} appears nowhere in the answer`);
 }
 check(Object.hasOwn(Object.fromEntries((await consoleAnswer(diagnoser)).servers.map(s=>[s.id,s]))[devA1].snapshot.processes[0],'path'),true,'diagnose still gets the process details');
 check(Object.hasOwn(Object.fromEntries((await consoleAnswer(viewOnly)).servers.map(s=>[s.id,s]))[devA1].snapshot.processes[0],'path'),false,'view only strips the process details as before');
 const issue=servers[devA1].issues.find(item=>item.ruleId==='threat-detected');
 check(issue,{key:'threats',ruleId:'threat-detected',level:'critical',live:false,params:{count:1,severity:'severe'}},'the issue params hold only count and severity');
 servers=await consoleServers(customerTech);
 check([devA1,devA2,devB].map(id=>lists(servers[id])),[[true,true],[false,false],[false,false]],'a customer role on group A gives the lists only on its devices');

 // ---- Customer boundary once a second customer exists ----
 await d.exec(boundaryPhase());
 await assign(reader,customerA);await assign(customerTech,customerA);await assign(customerTech,customerB);
 servers=await consoleServers(reader);
 check(Object.hasOwn(servers,devB),false,'a global Reader of customer A gets no device of customer B');
 check([devA1,devA2].map(id=>lists(servers[id])),[[true,true],[true,true]],'and the detections of customer A');
 const readerText=JSON.stringify(await consoleAnswer(reader));
 check(readerText.includes('DEV-B'),false,'the B device is absent from the whole answer');
 servers=await consoleServers(customerTech);
 check([devA1,devA2,devB].map(id=>Object.hasOwn(servers,id)),[true,true,true],'the technician of A and B sees all three devices');
 check([devA1,devA2,devB].map(id=>lists(servers[id])),[[true,true],[false,false],[false,false]],'the customer role of A gives detections only on its devices, never on B');
 servers=await consoleServers(owner);
 check([devA1,devA2,devB].map(id=>lists(servers[id])),[[true,true],[true,true],[true,true]],'the Owner keeps everything');

 // ---- No other answer carries the lists ----
 const routes=['app/api/heartbeat/route.ts','app/api/diagnostics/route.ts','app/api/files/route.ts','app/api/agent/terminal/route.ts','app/api/agent/rdp/route.ts'];
 for(const file of routes)check(/Response\.json\([^)]*snapshot/.test(readFileSync(file,'utf8')),false,`${file} returns no snapshot`);
 check(/snapshot:snapshotForPermissions\(s\.snapshot,permissions\)/.test(readFileSync('lib/server/devices/device-projection.ts','utf8'))&&readFileSync('app/api/console/route.ts','utf8').includes('projectDevices('),true,'the console route returns snapshots only through snapshotForPermissions (lib/server/devices/device-projection.ts)');
 check(/defender\.control/.test(readFileSync('app/api/console/route.ts','utf8')),false,'defender.control is used by no route in this slice');

 console.log(`PASS defender access (${checks} checks): seeded and migrated built-in roles, an idempotent 0014 that leaves custom roles alone, the console strip without defender.read (also with diagnose), the customer boundary for a global Reader and a customer role, and issue params without names, paths or users.`);
}finally{await d.close();}
