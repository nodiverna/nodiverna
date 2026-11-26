// ESU dates on PostgreSQL: GET/POST /api/os-support/esu and the osSupport of
// GET /api/console through the real routes, lib/server/devices/os-esu.ts, lib/server/identity/access.ts and the
// audit writer. Covers inheritance group → subgroup → device, the expected
// fence, date validation, rights, the customer boundary, audit rows with
// rollback, the cleanup triggers and the single ESU query of the console.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';
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
 '@/lib/server/devices/device-lifecycle':{removeDevice:async()=>({}),removeDevices:async()=>({}),sweepRemovedTransfers:async()=>{}},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
const load=sourceLoader();
const access=load('lib/server/identity/access.ts',imports);
const esuApi=load('app/api/os-support/esu/route.ts',imports),consoleApi=load('app/api/console/route.ts',imports);

const time=Date.now();
const insert=(table,row)=>insertRow(d,table,row);
async function persona(name){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@esu.test',display_name:name,auth_principal:principal,auth_email:name+'@esu.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@esu.test',principal});
}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){const id=uuid();await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${id},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);return id;}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};
// Windows 10 Enterprise 22H2: security support ended on 2025-10-14.
const snapshot=JSON.stringify({hostname:'H',os:'Microsoft Windows 10 Enterprise',build:'19045',cores:4,cpu:10,memory:10,disks:[],collectionErrors:[],processes:[],rebootPending:false,osInfo:{editionId:'Enterprise',installationType:'Client',displayVersion:'22H2',ubr:1,productName:'Windows 10 Enterprise',currentBuild:'19045'}});
async function device(name,groupId,customer=customerA){const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:Date.now(),management:1,snapshot,customer_id:customer});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});return id;}

const get=async(as,scopeType,scopeId)=>{viewer=as;const response=await esuApi.GET(new Request(`https://esu.test/api/os-support/esu?scopeType=${scopeType}&scopeId=${scopeId}`));return {status:response.status,body:await response.json()};};
const post=async(as,body)=>{viewer=as;const response=await esuApi.POST(new Request('https://esu.test/api/os-support/esu',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
const support=async as=>{viewer=as;const response=await consoleApi.GET(new Request("https://esu.test/api/console"));if(response.status!==200)console.error(await response.clone().text());assert.equal(response.status,200,"console GET");const data=await response.json();return Object.fromEntries(data.servers.map(s=>[s.id,{osSupport:s.osSupport,issue:s.issues.find(issue=>issue.ruleId==='os-support-end')?.level??null}]));};
const setEsu=(as,scopeType,scopeId,until,expected=null)=>post(as,{action:'set-esu',scopeType,scopeId,until,expected});
const clearEsu=(as,scopeType,scopeId,expected)=>post(as,{action:'clear-esu',scopeType,scopeId,expected});
const auditRows=()=>d.query(sql`SELECT action,target,scope,server_id AS "serverId",customer_id AS "customerId" FROM audit WHERE action LIKE 'os-esu.%' ORDER BY id`);
const esuRows=()=>d.query(sql`SELECT scope_type,scope_id,until,updated_at FROM os_esu_overrides ORDER BY scope_type,scope_id`);
async function refused(promise,status,code,label){
 const [beforeRows,beforeAudit]=await Promise.all([esuRows(),auditRows()]);
 const result=await promise;
 check(result.status,status,label);if(code!==undefined)check(result.body.code,code,label+' code');
 check(await esuRows(),beforeRows,label+' leaves the dates unchanged');check((await auditRows()).length,beforeAudit.length,label+' writes no audit row');
 return result;
}
const future=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);

try{
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const parent=await group('Parent',null),child=await group('Child',parent),groupB=await group('B group',null,customerB);
 const dev1=await device('DEV-1',child),dev2=await device('DEV-2',parent),devB=await device('DEV-B',groupB,customerB);
 const owner=await persona('owner'),operator=await persona('operator'),reader=await persona('reader'),parentManager=await persona('parent-manager'),technician=await persona('technician');
 await grant(owner,await role('Owner',['*']),'global');
 await grant(operator,await role('Operator',access.rolePermissions.operator),'global');
 await grant(reader,await role('Reader',access.rolePermissions.viewer),'global');
 const parentAssignment=await grant(parentManager,await role('Alerts on parent',['view','alerts.manage']),'devicegroup',parent);
 await grant(technician,await role('Technician',['view','alerts.manage']),'global');

 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 // ---- No ESU: the version has ended ----
 let state=await support(owner);
 check([state[dev1].osSupport.status,state[dev1].osSupport.effectiveEnd,state[dev1].osSupport.esu,state[dev1].issue],['ended','2025-10-14',undefined,'critical'],'Windows 10 22H2 without ESU has ended (critical issue)');
 let view=await get(reader,'device',dev1);
 check(view.body,{override:null,inherited:null,effective:null,canEdit:false,reason:'right'},'GET without any date; a Reader cannot edit');

 // ---- Set on the parent, inherit into the child group and the device ----
 const parentUntil=future(400);
 let result=await setEsu(parentManager,'group',parent,parentUntil);check(result.status,200,'the parent manager sets the parent group');
 view=await get(reader,'group',child);
 check([view.body.override,view.body.inherited,view.body.effective],[null,{until:parentUntil,origin:{type:'group',id:parent,name:'Parent',visible:true}},parentUntil],'the child group inherits from the parent');
 view=await get(reader,'device',dev1);
 check([view.body.inherited.origin.id,view.body.effective],[parent,parentUntil],'the device inherits through its child group');
 state=await support(owner);
 check([state[dev1].osSupport.status,state[dev1].osSupport.effectiveEnd,state[dev1].osSupport.esu],['supported',parentUntil,{until:parentUntil,origin:{type:'group',id:parent,name:'Parent'}}],'console: the ESU date keeps the device supported, with its origin');
 check(state[dev1].issue,null,'no support issue with ESU 400 days ahead');
 const childUntil=future(100);
 result=await setEsu(parentManager,'group',child,childUntil);check(result.status,200,'right on the parent group allows the child group');
 const childAt=result.body.updatedAt;
 state=await support(owner);
 check([state[dev1].osSupport.status,state[dev1].osSupport.daysLeft<=100,state[dev1].osSupport.esu.origin.id,state[dev1].issue],['ending',true,child,'warning'],'the inner group beats the outer one; 100 days left is ending (warning)');
 check(state[dev2].osSupport.esu.origin.id,parent,'the parent device keeps the parent date');
 result=await setEsu(operator,'device',dev1,future(700));check(result.status,200,'Operator allowed on the device');
 const deviceAt=result.body.updatedAt;
 state=await support(owner);check([state[dev1].osSupport.status,state[dev1].osSupport.esu.origin.type],['supported','device'],'the device beats its groups');
 check(state[dev2].osSupport.esu.origin.type,'group','other devices are unchanged');
 // An ESU date before the catalog end does not shorten the support.
 view=await get(operator,'device',dev1);check([view.body.override.until,view.body.override.updatedAt,view.body.canEdit,view.body.reason],[future(700),deviceAt,true,null],'GET with the own date and its updatedAt');

 // ---- Fence and validation ----
 await refused(setEsu(operator,'device',dev1,future(10),null),409,'OS_ESU_CHANGED','create while a date exists');
 await refused(setEsu(operator,'device',dev1,future(10),deviceAt-1),409,'OS_ESU_CHANGED','stale expected');
 await refused(clearEsu(operator,'device',dev2,null),409,'OS_ESU_CHANGED','clear without a date');
 for(const [label,until] of [['not a calendar date','2025-02-30'],['before 2000','1999-12-31'],['after 2040','2041-01-01'],['wrong format','2025-1-1'],['no string',20250101]])await refused(setEsu(operator,'device',dev2,until),400,'OS_ESU_INVALID',label);
 await refused(post(operator,{action:'set-esu',scopeType:'tenant',scopeId:customerA,until:'2027-01-01',expected:null}),400,'OS_ESU_INVALID','unknown scope type');
 await refused(post(operator,{action:'set-esu',scopeType:'device',scopeId:dev2,until:'2027-01-01',expected:'x'}),400,'OS_ESU_INVALID','expected not a number');
 result=await setEsu(operator,'device',dev2,'2040-12-31');check(result.status,200,'the last allowed date');
 const dev2At=result.body.updatedAt;
 result=await setEsu(operator,'device',dev2,'2000-01-01',dev2At);check(result.status,200,'replace with the shown updatedAt');
 check(result.body.updatedAt>dev2At,true,'updatedAt moves forward');
 result=await clearEsu(operator,'device',dev2,result.body.updatedAt);check([result.status,result.body.updatedAt],[200,null],'clear the device date');

 // ---- Rights ----
 await refused(setEsu(reader,'device',dev2,'2030-01-01'),403,undefined,'Reader denied');
 await refused(setEsu(parentManager,'device',devB,'2030-01-01'),403,undefined,'no right on another device');
 db.beforeNextTransaction(()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${parentAssignment}`));
 await refused(clearEsu(parentManager,'group',child,childAt),403,undefined,'right lost before the commit');
 await grant(parentManager,await role('Alerts on parent again',['view','alerts.manage']),'devicegroup',parent);

 // ---- Audit ----
 const rows=await auditRows();
 check(rows.map(row=>row.action),['os-esu.set','os-esu.set','os-esu.set','os-esu.set','os-esu.set','os-esu.clear'],'one audit row per change');
 check([rows[0].scope,rows[0].serverId,rows[0].customerId],['portal',null,customerA],'group: portal row with the group customer');
 check(JSON.parse(rows[0].target),{scope:`group:${parent}`,old:{until:null,origin:null},new:{until:parentUntil,origin:`group:${parent}`}},'group: old and new value');
 check(JSON.parse(rows[1].target).old,{until:parentUntil,origin:`group:${parent}`},'child group: the old value is inherited from the parent');
 check([rows[2].scope,rows[2].serverId,rows[2].customerId],['device',dev1,customerA],'device: device row with its customer');
 check(JSON.parse(rows[5].target).new,{until:parentUntil,origin:`group:${parent}`},'clear: the new value is the inherited one');
 await createTrigger(d,'esu_audit_fails','audit','BEFORE INSERT',{message:'audit-down',when:"NEW.action LIKE 'os-esu.%'"});
 const beforeFailure=await esuRows();
 result=await clearEsu(parentManager,'group',child,childAt);check(result.status,500,'an audit failure fails the request');
 check(await esuRows(),beforeFailure,'an audit failure rolls the change back');
 await dropTrigger(d,'esu_audit_fails');

 // ---- One ESU statement in the console ----
 let statements=0;db.hooks.statement=text=>{if(/os_esu_overrides/.test(text))statements++;};await support(owner);db.hooks.statement=null;
 check(statements,1,'the console reads the ESU dates of all visible devices in one statement');

 // ---- Customer boundary ----
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 check((await get(technician,'group',groupB)).status,404,'customer B group answers 404');
 check((await get(technician,'device',devB)).status,404,'customer B device answers 404');
 await refused(setEsu(technician,'group',groupB,'2030-01-01'),404,undefined,'set on a customer B group');
 await refused(setEsu(technician,'device',devB,'2030-01-01'),404,undefined,'set on a customer B device');
 state=await support(technician);check([Object.hasOwn(state,dev1),Object.hasOwn(state,devB)],[true,false],'the console sends no customer B device');

 // ---- Cleanup triggers ----
 const empty=await group('Empty',null);await setEsu(owner,'group',empty,'2030-01-01');
 check((await d.query(sql`SELECT 1 FROM os_esu_overrides WHERE scope_id=${empty}`)).length,1,'group date exists');
 await d.exec(sql`DELETE FROM device_groups WHERE id=${empty}`);
 check((await d.query(sql`SELECT 1 FROM os_esu_overrides WHERE scope_id=${empty}`)).length,0,'deleting the group deletes its date');
 check((await d.query(sql`SELECT 1 FROM os_esu_overrides WHERE scope_id=${dev1}`)).length,1,'device date exists');
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${dev1}`);
 check((await d.query(sql`SELECT 1 FROM os_esu_overrides WHERE scope_id=${dev1}`)).length,0,'removing the device deletes its date');
 console.log(`PASS os support ESU (${checks} checks): inheritance into the console osSupport, expected fence, date validation, rights, customer boundary, audit with rollback, one query and cleanup triggers.`);
}finally{await d.close();}
