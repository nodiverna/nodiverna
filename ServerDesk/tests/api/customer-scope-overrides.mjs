// The customer level of alert rules and ESU dates against PostgreSQL, through the real routes
// GET/POST /api/alert-rules, GET/POST /api/os-support/esu and GET /api/console with
// lib/server/devices/alert-rule-overrides.ts, lib/server/devices/os-esu.ts, lib/server/identity/access.ts and the
// audit writer. Covers the migration (the CHECKs accept customer, the effective settings and origins of existing
// overrides stay the same, the customer-delete cleanup triggers), the customer rule table and ESU value with their
// chain and inherited values, the rights (global alerts.manage and sight of the customer: 403 or 404 before the
// body, canEdit with reason customer-right, a right lost before the commit), the expected fence, the audit rows with
// customerId and origins and their rollback, the customer origin and inherited value on groups and devices, the
// console issues and osSupport that follow a customer value, and the one overrides and one ESU statement of the console.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {copyFile,mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {testDatabase} from '../support/postgres.mjs';
import {migrateDatabase} from '../../scripts/selfhost.mjs';
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
const access=load('lib/server/identity/access.ts',imports),rules=load('lib/alert-rules.ts');
const rulesApi=load('app/api/alert-rules/route.ts',imports),esuApi=load('app/api/os-support/esu/route.ts',imports),consoleApi=load('app/api/console/route.ts',imports);

const time=Date.now();
const insert=(table,row)=>insertRow(d,table,row);
async function persona(name){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@customer-level.test',display_name:name,auth_principal:principal,auth_email:name+'@customer-level.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@customer-level.test',principal});
}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){const id=uuid();await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${id},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);return id;}
const customer=async name=>{const id=uuid();await insert('customers',{id,name,created_at:time,updated_at:time});return id;};
const group=async(name,parent,customerId)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customerId});return id;};
// CPU 88 % (a warning by default) on Windows 10 Enterprise 22H2, whose security support ended on 2025-10-14.
const snapshot=JSON.stringify({hostname:'H',os:'Microsoft Windows 10 Enterprise',build:'19045',cores:4,cpu:88,memory:10,disks:[],collectionErrors:[],processes:[],rebootPending:false,osInfo:{editionId:'Enterprise',installationType:'Client',displayVersion:'22H2',ubr:1,productName:'Windows 10 Enterprise',currentBuild:'19045'}});
async function device(name,groupId,customerId){const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:Date.now(),management:1,snapshot,customer_id:customerId});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});return id;}

const call=async(api,method,as,url,body)=>{viewer=as;const response=await api[method](new Request(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined));return {status:response.status,body:await response.json()};};
const getRules=(as,scopeType,scopeId)=>call(rulesApi,'GET',as,`https://level.test/api/alert-rules?scopeType=${scopeType}&scopeId=${scopeId}`);
const postRules=(as,body)=>call(rulesApi,'POST',as,'https://level.test/api/alert-rules',body);
const getEsu=(as,scopeType,scopeId)=>call(esuApi,'GET',as,`https://level.test/api/os-support/esu?scopeType=${scopeType}&scopeId=${scopeId}`);
const postEsu=(as,body)=>call(esuApi,'POST',as,'https://level.test/api/os-support/esu',body);
const consoleRows=async as=>{viewer=as;const response=await consoleApi.GET(new Request('https://level.test/api/console'));assert.equal(response.status,200,'console GET');return Object.fromEntries((await response.json()).servers.map(s=>[s.id,s]));};
const cpuLevel=row=>row?.issues.find(issue=>issue.ruleId==='cpu')?.level??null;
const rule=(view,id='cpu')=>view.body.rules.find(row=>row.ruleId===id);
const setRule=(as,scopeType,scopeId,settings,expected=null)=>postRules(as,{action:'set-rule',scopeType,scopeId,ruleId:'cpu',durationMinutes:5,recovery:5,expected,...settings});
const resetRule=(as,scopeType,scopeId,expected)=>postRules(as,{action:'reset-rule',scopeType,scopeId,ruleId:'cpu',expected});
const setEsu=(as,scopeType,scopeId,until,expected=null)=>postEsu(as,{action:'set-esu',scopeType,scopeId,until,expected});
const clearEsu=(as,scopeType,scopeId,expected)=>postEsu(as,{action:'clear-esu',scopeType,scopeId,expected});
const auditRows=prefix=>d.query(sql`SELECT action,target,scope,server_id AS "serverId",customer_id AS "customerId" FROM audit WHERE action LIKE ${prefix+'%'} ORDER BY id`);
const ruleRows=()=>d.query(sql`SELECT rule_id,scope_type,scope_id,enabled,warning,critical,updated_at FROM alert_rule_overrides ORDER BY rule_id,scope_type,scope_id`);
const esuRows=()=>d.query(sql`SELECT scope_type,scope_id,until,updated_at FROM os_esu_overrides ORDER BY scope_type,scope_id`);
async function refused(promise,status,code,label){
 const [beforeRules,beforeEsu,beforeAudit]=await Promise.all([ruleRows(),esuRows(),d.query(sql`SELECT count(*)::int AS n FROM audit`)]);
 const result=await promise;
 check(result.status,status,label);if(code!==undefined)check(result.body.code,code,label+' code');
 check([await ruleRows(),await esuRows(),(await d.query(sql`SELECT count(*)::int AS n FROM audit`))[0].n],[beforeRules,beforeEsu,beforeAudit[0].n],label+' changes nothing and writes no audit row');
 return result;
}
const future=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);

// ---- Migration: existing overrides keep their effective settings and origins ----
// The migrations before the customer level, a seeded database with global, group and device overrides, then the new
// migration: no row changes, and every device resolves the same values and origins with its customer in the chain.
async function migrationKeepsEffectiveSettings(){
 const directory=path.resolve('drizzle'),names=(await readdir(directory)).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
 let migration=null;for(const name of names)if((await readFile(path.join(directory,name),'utf8')).includes('alert_rule_overrides_removed_customer'))migration=name;
 assert.ok(migration,'the customer level migration exists');
 const temporary=await mkdtemp(path.join(os.tmpdir(),'serverdesk-customer-level-'));
 const database=await testDatabase({template:false});
 try{
  const earlier=names.filter(name=>name<migration);
  for(const name of earlier)await copyFile(path.join(directory,name),path.join(temporary,name));
  await migrateDatabase(database,{directory:temporary});
  const other=uuid(),g1=uuid(),g2=uuid(),gOther=uuid(),devices=[uuid(),uuid(),uuid(),uuid()];
  await database.exec(sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${other},'Other',${time},${time})`);
  await database.exec(sql`INSERT INTO device_groups(id,name,description,created_at,parent_id,customer_id) VALUES(${g1},'Outer','',${time},NULL,${customerA}),(${g2},'Inner','',${time},${g1},${customerA}),(${gOther},'Other group','',${time},NULL,${other})`);
  for(const [index,id] of devices.entries())await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,management,customer_id) VALUES(${id},${'M-'+index},${'fixture-'+id},${time},1,${index===3?other:customerA})`);
  await database.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${devices[0]},${g2}),(${devices[1]},${g1}),(${devices[3]},${gOther})`);
  const seed=(ruleId,scopeType,scopeId,warning,critical)=>database.exec(sql`INSERT INTO alert_rule_overrides(id,rule_id,scope_type,scope_id,enabled,warning,critical,level,duration_minutes,recovery,actor,updated_at) VALUES(${uuid()},${ruleId},${scopeType},${scopeId},1,${warning},${critical},NULL,5,5,'fixture',${time})`);
  await seed('cpu','global','*',70,85);await seed('cpu','group',g1,60,90);await seed('memory','group',g2,50,95);await seed('cpu','device',devices[0],40,45);await seed('memory','group',gOther,30,35);
  await assert.rejects(database.exec(sql`INSERT INTO alert_rule_overrides(id,rule_id,scope_type,scope_id,enabled,actor,updated_at) VALUES(${uuid()},'cpu','customer',${customerA},1,'fixture',${time})`),/alert_rule_overrides_scope_type_check/,'before the migration a customer row is refused');
  const read=async()=>({
   overrides:(await database.query(sql`SELECT rule_id,scope_type,scope_id,enabled,warning,critical,level,duration_minutes,recovery,updated_at FROM alert_rule_overrides`)).map(row=>({ruleId:row.rule_id,scopeType:row.scope_type,scopeId:row.scope_id,enabled:Number(row.enabled)===1,warning:row.warning,critical:row.critical,level:row.level,durationMinutes:row.duration_minutes,recovery:row.recovery,updatedAt:Number(row.updated_at)})),
   devices:await database.query(sql`SELECT s.id,s.customer_id,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'depth',(SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=g.id))),'[]'::jsonb) FROM device_groups g WHERE EXISTS (SELECT 1 FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id=s.id AND a.ancestor_id=g.id)) AS groups FROM servers s ORDER BY s.id`),
  });
  const effective=(state,withCustomer)=>Object.fromEntries(state.devices.map(row=>[row.id,rules.resolveAlertRules(state.overrides,rules.deviceAlertChain(row.id,typeof row.groups==='string'?JSON.parse(row.groups):row.groups,withCustomer?row.customer_id:undefined))]));
  const before=await read(),rawBefore=await database.query(sql`SELECT * FROM alert_rule_overrides ORDER BY id`);
  await copyFile(path.join(directory,migration),path.join(temporary,migration));
  check(await migrateDatabase(database,{directory:temporary}),{applied:1,total:earlier.length+1},'the customer level migration applies');
  check(await database.query(sql`SELECT * FROM alert_rule_overrides ORDER BY id`),rawBefore,'the migration changes no override row');
  const after=await read();
  check(effective(after,true),effective(before,false),'every device keeps its effective settings and origins with its customer in the chain');
  check(effective(after,true)[devices[0]].cpu.origin,{type:'device',id:devices[0]},'the fixture has a device origin');
  check(effective(after,true)[devices[2]].cpu.origin,{type:'global',id:'*'},'and a global origin on a device without group');
  await database.exec(sql`INSERT INTO alert_rule_overrides(id,rule_id,scope_type,scope_id,enabled,actor,updated_at) VALUES(${uuid()},'cpu','customer',${customerA},1,'fixture',${time})`);
  await database.exec(sql`INSERT INTO os_esu_overrides(id,scope_type,scope_id,until,actor,updated_at) VALUES(${uuid()},'customer',${customerA},'2030-01-01','fixture',${time})`);
  check([(await database.query(sql`SELECT 1 FROM alert_rule_overrides WHERE scope_type='customer'`)).length,(await database.query(sql`SELECT 1 FROM os_esu_overrides WHERE scope_type='customer'`)).length],[1,1],'after the migration both tables accept a customer row');
  await assert.rejects(database.exec(sql`INSERT INTO alert_rule_overrides(id,rule_id,scope_type,scope_id,enabled,actor,updated_at) VALUES(${uuid()},'cpu','tenant',${customerA},1,'fixture',${time})`),/alert_rule_overrides_scope_type_check/,'an unknown scope type is still refused');
  await assert.rejects(database.exec(sql`INSERT INTO os_esu_overrides(id,scope_type,scope_id,until,actor,updated_at) VALUES(${uuid()},'global','*','2030-01-01','fixture',${time})`),/os_esu_overrides_scope_type_check/,'ESU has no All devices level');
  await assert.rejects(database.exec(sql`INSERT INTO alert_rule_overrides(id,rule_id,scope_type,scope_id,enabled,actor,updated_at) VALUES(${uuid()},'memory','customer','*',1,'fixture',${time})`),/alert_rule_overrides_scope_id_check/,'the global/* check stays');
  checks+=4;
 }finally{await database.close();await rm(temporary,{recursive:true,force:true});}
}

try{
 await migrationKeepsEffectiveSettings();

 // ---- Fixture: customer A (default) with a group path and a loose device, customer B with a group ----
 const customerB=await customer('Customer B');
 await d.exec(sql`UPDATE customers SET name='Customer A' WHERE id=${customerA}`);
 const parent=await group('Parent',null,customerA),child=await group('Child',parent,customerA),groupB=await group('B group',null,customerB);
 const dev1=await device('DEV-1',child,customerA),loose=await device('LOOSE',null,customerA),devB=await device('DEV-B',groupB,customerB);
 const owner=await persona('owner'),manager=await persona('manager'),groupManager=await persona('group-manager'),reader=await persona('reader'),technician=await persona('technician');
 await grant(owner,await role('Owner',['*']),'global');
 const managerAssignment=await grant(manager,await role('Alerts everywhere',['view','alerts.manage']),'global');
 await grant(groupManager,await role('Alerts on parent',['view','alerts.manage']),'devicegroup',parent);
 await grant(reader,await role('Reader',access.rolePermissions.viewer),'global');
 await grant(technician,await role('Technician',['view','alerts.manage']),'global');
 await d.exec(everyCustomer(time));

 // ---- GET on a customer: the rule table with the chain global → customer ----
 let view=await getRules(reader,'customer',customerA);
 check([view.status,view.body.scope,view.body.rules.length],[200,{type:'customer',id:customerA,name:'Customer A'},41],'GET customer: the 41 rules with the customer name');
 check([rule(view).origin,rule(view).override,rule(view).inherited.origin],[{type:'default'},null,{type:'default'}],'without overrides: default');
 check([view.body.canEdit,view.body.reason],[false,'customer-right'],'a Reader cannot edit a customer: reason customer-right');
 check([(await getRules(groupManager,'customer',customerA)).body.reason,(await getRules(manager,'customer',customerA)).body.canEdit],['customer-right',true],'a group manager cannot edit the customer; a global alerts.manage can');
 check(((await getRules(reader,'customer',uuid()))).body.code,'CUSTOMER_MISSING','an unknown customer answers CUSTOMER_MISSING');
 check([(await getRules(reader,'customer',uuid())).status,(await getRules(reader,'customer','not-a-guid')).status,(await getRules(reader,'customer','not-a-guid')).body.code],[404,400,'ALERT_RULE_INVALID'],'404 for an unknown customer, 400 for a bad id');

 // ---- Set on All devices and on the customer ----
 let result=await setRule(owner,'global','*',{enabled:true,warning:70,critical:95});check(result.status,200,'All devices: warning 70');
 let rows=await consoleRows(owner);check([cpuLevel(rows[dev1]),cpuLevel(rows[loose]),cpuLevel(rows[devB])],['warning','warning','warning'],'console: global warning everywhere');
 view=await getRules(reader,'customer',customerA);
 check([rule(view).origin,rule(view).inherited.origin],[{type:'global',id:'*',name:'',visible:true},{type:'global',id:'*',name:'',visible:true}],'the customer inherits from All devices');
 await refused(setRule(groupManager,'customer',customerA,{enabled:true,warning:80,critical:85}),403,'FORBIDDEN','a group manager cannot set the customer');
 check((await setRule(groupManager,'customer',customerA,{enabled:true,warning:80,critical:85})).body.error.includes('All devices'),true,'the 403 names the global permission (apiError.alerts.customerForbidden)');
 await refused(setRule(groupManager,'customer',customerA,{enabled:true,warning:101,critical:85},'x'),403,'FORBIDDEN','the right comes before the body');
 await refused(setRule(manager,'customer',uuid(),{enabled:true,warning:80,critical:85}),404,'CUSTOMER_MISSING','an unknown customer');
 result=await setRule(manager,'customer',customerA,{enabled:true,warning:80,critical:85});check(result.status,200,'a global alerts.manage sets the customer');
 const customerAt=result.body.updatedAt;
 view=await getRules(reader,'customer',customerA);
 check([rule(view).origin,rule(view).override.updatedAt,rule(view).effective.critical,rule(view).inherited.origin.type,rule(view).inherited.settings.warning],[{type:'customer',id:customerA,name:'Customer A',visible:true},customerAt,85,'global',70],'customer: own override, inherited from All devices');
 rows=await consoleRows(owner);
 check([cpuLevel(rows[dev1]),cpuLevel(rows[loose]),cpuLevel(rows[devB])],['critical','critical','warning'],'console: the customer threshold reaches its grouped and loose devices, not customer B');

 // ---- Group and device views show the customer origin ----
 view=await getRules(reader,'group',parent);
 check([rule(view).origin,rule(view).inherited.origin],[{type:'customer',id:customerA,name:'Customer A',visible:true},{type:'customer',id:customerA,name:'Customer A',visible:true}],'a root group inherits from its customer');
 view=await getRules(reader,'device',loose);
 check([rule(view).origin.type,rule(view).inherited.settings.critical],['customer',85],'a device without group inherits from its customer');
 view=await getRules(reader,'group',groupB);check(rule(view).origin.type,'global','a group of customer B does not see customer A');
 result=await setRule(groupManager,'group',parent,{enabled:true,warning:60,critical:99});check(result.status,200,'the group manager changes the group below the customer');
 const parentAt=result.body.updatedAt;
 view=await getRules(reader,'device',dev1);check([rule(view).origin.id,rule(view).inherited.origin.id],[parent,parent],'the group wins over the customer');
 rows=await consoleRows(owner);check([cpuLevel(rows[dev1]),cpuLevel(rows[loose])],['warning','critical'],'console: group over customer');

 // ---- Fence and validation on a customer ----
 await refused(setRule(manager,'customer',customerA,{enabled:true,warning:75,critical:85},null),409,'ALERT_RULE_CHANGED','create while the customer override exists');
 await refused(setRule(manager,'customer',customerA,{enabled:true,warning:75,critical:85},customerAt-1),409,'ALERT_RULE_CHANGED','stale expected');
 await refused(setRule(manager,'customer',customerA,{enabled:true,warning:95,critical:85},customerAt),400,'ALERT_RULE_INVALID','warning after critical');
 result=await setRule(manager,'customer',customerA,{enabled:true,warning:75,critical:86},customerAt);check(result.status,200,'replace with the shown updated_at');
 const customerAt2=result.body.updatedAt;

 // ---- A right lost between the check and the commit ----
 db.beforeNextTransaction(()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${managerAssignment}`));
 await refused(setRule(manager,'customer',customerA,{enabled:true,warning:74,critical:86},customerAt2),403,'FORBIDDEN','right lost before the commit: the pre-check answer');
 await grant(manager,await role('Alerts everywhere again',['view','alerts.manage']),'global');

 // ---- Audit ----
 let audit=await auditRows('alert-rule.');
 const customerRows=audit.filter(row=>JSON.parse(row.target).scope===`customer:${customerA}`);
 check(customerRows.map(row=>[row.action,row.scope,row.serverId,row.customerId]),[['alert-rule.set','portal',null,customerA],['alert-rule.set','portal',null,customerA]],'one audit row per customer change, with the customer');
 check(JSON.parse(customerRows[0].target),{rule:'cpu',scope:`customer:${customerA}`,old:{enabled:true,warning:70,critical:95,level:null,durationMinutes:5,recovery:5,origin:'global'},new:{enabled:true,warning:80,critical:85,level:null,durationMinutes:5,recovery:5,origin:`customer:${customerA}`}},'customer: old from global, new on the customer');
 check(JSON.parse(audit.find(row=>JSON.parse(row.target).scope===`group:${parent}`).target).old.origin,`customer:${customerA}`,'a group change whose old value came from the customer');
 await createTrigger(d,'customer_rule_audit_fails','audit','BEFORE INSERT',{message:'audit-down',when:"NEW.action LIKE 'alert-rule.%'"});
 const beforeFailure=await ruleRows();
 result=await resetRule(manager,'customer',customerA,customerAt2);check(result.status,500,'an audit failure fails the reset');
 check(await ruleRows(),beforeFailure,'and rolls it back');
 await dropTrigger(d,'customer_rule_audit_fails');

 // ---- One overrides statement in the console, with the customer rows ----
 let statements=0;db.hooks.statement=text=>{if(/alert_rule_overrides/.test(text))statements++;};await consoleRows(owner);db.hooks.statement=null;
 check(statements,1,'the console reads global, customer, group and device overrides in one statement');

 // ---- Reset on the customer: the group and loose device follow ----
 await resetRule(groupManager,'group',parent,parentAt);
 result=await resetRule(manager,'customer',customerA,customerAt2);check([result.status,result.body.updatedAt],[200,null],'reset the customer override');
 audit=await auditRows('alert-rule.');
 check(JSON.parse(audit.at(-1).target).new.origin,'global','reset: the new value comes from All devices');
 check(audit.at(-1).customerId,customerA,'reset: audit row with the customer');
 rows=await consoleRows(owner);check([cpuLevel(rows[dev1]),cpuLevel(rows[loose])],['warning','warning'],'console: back to All devices');

 // ---- ESU on a customer ----
 let esu=await getEsu(reader,'customer',customerA);
 check(esu.body,{override:null,inherited:null,effective:null,canEdit:false,reason:'customer-right'},'GET customer ESU: nothing set, a Reader has reason customer-right');
 check([(await getEsu(groupManager,'customer',customerA)).body.reason,(await getEsu(manager,'customer',customerA)).body.canEdit],['customer-right',true],'the customer ESU needs the global alerts.manage');
 check([(await getEsu(reader,'customer',uuid())).status,(await getEsu(reader,'customer','x')).body.code],[404,'OS_ESU_INVALID'],'404 for an unknown customer, 400 for a bad id');
 await refused(setEsu(groupManager,'customer',customerA,future(300)),403,'FORBIDDEN','a group manager cannot set the customer ESU date');
 await refused(setEsu(groupManager,'customer',customerA,'not-a-date'),403,'FORBIDDEN','the right comes before the body');
 const customerUntil=future(300);
 result=await setEsu(manager,'customer',customerA,customerUntil);check(result.status,200,'a global alerts.manage sets the customer ESU date');
 const esuAt=result.body.updatedAt;
 await refused(setEsu(manager,'customer',customerA,future(10),null),409,'OS_ESU_CHANGED','ESU fence: create while a date exists');
 esu=await getEsu(reader,'customer',customerA);check([esu.body.override,esu.body.inherited,esu.body.effective],[{until:customerUntil,updatedAt:esuAt},null,customerUntil],'the customer has its own date and inherits nothing');
 esu=await getEsu(reader,'group',child);
 check([esu.body.inherited,esu.body.effective],[{until:customerUntil,origin:{type:'customer',id:customerA,name:'Customer A',visible:true}},customerUntil],'a group without dates inherits the customer date');
 esu=await getEsu(reader,'device',loose);check(esu.body.inherited.origin.type,'customer','a device without group inherits the customer date');
 rows=await consoleRows(owner);
 check([rows[dev1].osSupport.esu,rows[devB].osSupport.esu],[{until:customerUntil,origin:{type:'customer',id:customerA,name:'Customer A'}},undefined],'console osSupport: the customer date with its named origin, not for customer B');
 check(rows[loose].osSupport.status,'supported','the customer date keeps the ended version supported');
 const groupUntil=future(500);
 result=await setEsu(groupManager,'group',parent,groupUntil);check(result.status,200,'a group date below the customer');
 esu=await getEsu(reader,'device',dev1);check(esu.body.inherited.origin,{type:'group',id:parent,name:'Parent',visible:true},'the closest group beats the customer');
 statements=0;db.hooks.statement=text=>{if(/os_esu_overrides/.test(text))statements++;};await consoleRows(owner);db.hooks.statement=null;
 check(statements,1,'the console reads every ESU row, also of the customers, in one statement');
 result=await clearEsu(manager,'customer',customerA,esuAt);check(result.status,200,'clear the customer date');
 audit=await auditRows('os-esu.');
 check(audit.map(row=>[row.action,row.scope,row.customerId]),[['os-esu.set','portal',customerA],['os-esu.set','portal',customerA],['os-esu.clear','portal',customerA]],'ESU audit rows with the customer');
 check(JSON.parse(audit[0].target),{scope:`customer:${customerA}`,old:{until:null,origin:null},new:{until:customerUntil,origin:`customer:${customerA}`}},'customer ESU: old and new');
 check(JSON.parse(audit[1].target).old,{until:customerUntil,origin:`customer:${customerA}`},'a group date whose old value came from the customer');

 // ---- Customer boundary ----
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 check([(await getRules(technician,'customer',customerB)).status,(await getRules(technician,'customer',customerB)).body.code],[404,'CUSTOMER_MISSING'],'a customer outside the boundary answers 404');
 await refused(setRule(technician,'customer',customerB,{enabled:true,warning:80,critical:85}),404,'CUSTOMER_MISSING','set on a customer outside the boundary');
 await refused(setRule(technician,'customer',customerB,{enabled:true,warning:101,critical:85},'x'),404,'CUSTOMER_MISSING','the boundary comes before the body');
 await refused(setEsu(technician,'customer',customerB,future(30)),404,'CUSTOMER_MISSING','ESU on a customer outside the boundary');
 check((await getRules(technician,'customer',customerA)).body.canEdit,true,'the technician of customer A with the global right edits customer A');
 result=await setRule(technician,'customer',customerA,{enabled:true,warning:81,critical:86});check(result.status,200,'and sets its rules');
 check((await getRules(technician,'global','*')).body.reason,'customer-boundary','All devices keeps its boundary reason');

 // ---- Cleanup when a customer is deleted ----
 // A plain delete of an empty customer (its audit rows would stay with its id, docs/customers.md "Delete a customer"); the override rows are written directly.
 const gone=await customer('Gone');
 await insert('alert_rule_overrides',{id:uuid(),rule_id:'cpu',scope_type:'customer',scope_id:gone,enabled:0,actor:'fixture',updated_at:time});
 await insert('os_esu_overrides',{id:uuid(),scope_type:'customer',scope_id:gone,until:future(40),actor:'fixture',updated_at:time});
 await d.exec(sql`DELETE FROM customers WHERE id=${gone}`);
 check([(await d.query(sql`SELECT 1 FROM alert_rule_overrides WHERE scope_id=${gone}`)).length,(await d.query(sql`SELECT 1 FROM os_esu_overrides WHERE scope_id=${gone}`)).length],[0,0],'deleting the customer deletes its rules and ESU date');
 check((await d.query(sql`SELECT 1 FROM alert_rule_overrides WHERE scope_type='customer' AND scope_id=${customerA}`)).length,1,'other customers keep theirs');
 console.log(`PASS customer scope overrides (${checks} checks): migration with unchanged effective settings and the new checks, the customer rule table and ESU value, rights and boundary before the body, a lost right, the expected fence, audit with customer and origins and rollback, customer origins and inherited values on groups and devices, console issues and osSupport, one statement each and the customer-delete cleanup.`);
}finally{await d.close();}
