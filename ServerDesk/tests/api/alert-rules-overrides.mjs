// Alert rule overrides with inheritance against PostgreSQL: GET/POST
// /api/alert-rules and the issues of GET /api/console through the real routes,
// lib/server/devices/alert-rule-overrides.ts, lib/server/identity/access.ts and the audit writer. Covers the
// chain global → parent → child group → device, moving a device, reset, the
// `expected` fence, rights, the customer boundary, audit rows with rollback,
// validation, the minimum duration and recovery margin, the cleanup triggers and
// the single overrides query of the console.
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
const rulesApi=load('app/api/alert-rules/route.ts',imports),consoleApi=load('app/api/console/route.ts',imports);

const time=Date.now();
const insert=(table,row)=>insertRow(d,table,row);
async function persona(name){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@alerts.test',display_name:name,auth_principal:principal,auth_email:name+'@alerts.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@alerts.test',principal});
}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){const id=uuid();await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${id},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);return id;}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};
const snapshot=JSON.stringify({hostname:'H',os:'Microsoft Windows Server 2025',cores:4,cpu:88,memory:10,disks:[],collectionErrors:[],processes:[],rebootPending:false});
async function device(name,groupId,customer=customerA){const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:Date.now(),management:1,snapshot,customer_id:customer});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});return id;}

const get=async(as,scopeType,scopeId)=>{viewer=as;const response=await rulesApi.GET(new Request(`https://alerts.test/api/alert-rules?scopeType=${scopeType}&scopeId=${scopeId}`));return {status:response.status,body:await response.json()};};
const post=async(as,body)=>{viewer=as;const response=await rulesApi.POST(new Request('https://alerts.test/api/alert-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
const consoleIssues=async as=>{viewer=as;const response=await consoleApi.GET(new Request('https://alerts.test/api/console'));assert.equal(response.status,200,'console GET');const data=await response.json();return Object.fromEntries(data.servers.map(s=>[s.id,s.issues]));};
const cpuLevel=(issues,id)=>issues[id]?.find(issue=>issue.ruleId==='cpu')?.level??null;
const rule=(view,id='cpu')=>view.body.rules.find(row=>row.ruleId===id);
const auditRows=()=>d.query(sql`SELECT action,target,scope,server_id AS "serverId",customer_id AS "customerId" FROM audit WHERE action LIKE 'alert-rule.%' ORDER BY id`);
const overrideRows=()=>d.query(sql`SELECT rule_id,scope_type,scope_id,enabled,warning,critical,level,duration_minutes,recovery,updated_at FROM alert_rule_overrides ORDER BY rule_id,scope_type,scope_id`);
// CPU is an alarm rule: a change without its own minimum duration and margin sends the catalog defaults.
const alarmDefaults=ruleId=>ruleId==='cpu'?{durationMinutes:5,recovery:5}:{};
const set=(as,scopeType,scopeId,settings,expected=null,ruleId='cpu')=>post(as,{action:'set-rule',scopeType,scopeId,ruleId,expected,...alarmDefaults(ruleId),...settings});
const reset=(as,scopeType,scopeId,expected,ruleId='cpu')=>post(as,{action:'reset-rule',scopeType,scopeId,ruleId,expected});
async function refused(promise,status,code,label){
 const [beforeRows,beforeAudit]=await Promise.all([overrideRows(),auditRows()]);
 const result=await promise;
 check(result.status,status,label);if(code!==undefined)check(result.body.code,code,label+' code');
 check(await overrideRows(),beforeRows,label+' leaves the overrides unchanged');check((await auditRows()).length,beforeAudit.length,label+' writes no audit row');
 return result;
}

try{
 // ---- Fixture ----
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const parent=await group('Parent',null),child=await group('Child',parent),sibling=await group('Sibling',parent),groupB=await group('B group',null,customerB);
 const dev1=await device('DEV-1',child),dev2=await device('DEV-2',parent),loose=await device('LOOSE',null),devB=await device('DEV-B',groupB,customerB);
 const owner=await persona('owner'),operator=await persona('operator'),reader=await persona('reader'),parentManager=await persona('parent-manager'),deviceManager=await persona('device-manager'),viewOnly=await persona('view-only'),technician=await persona('technician');
 await grant(owner,await role('Owner',['*']),'global');
 await grant(operator,await role('Operator',access.rolePermissions.operator),'global');
 await grant(reader,await role('Reader',access.rolePermissions.viewer),'global');
 const parentAssignment=await grant(parentManager,await role('Alerts on parent',['view','alerts.manage']),'devicegroup',parent);
 const deviceRole=await role('Alerts on device',['view','alerts.manage']);await grant(deviceManager,deviceRole,'device',dev1);await grant(deviceManager,await role('View all',['view']),'global');
 await grant(viewOnly,await role('View',['view']),'global');
 await grant(technician,await role('Technician',['view','alerts.manage']),'global');
 check(access.rolePermissions.operator.includes('alerts.manage'),true,'Operator holds alerts.manage');check(access.rolePermissions.viewer.includes('alerts.manage'),false,'Reader does not');

 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 // ---- Defaults on all three levels ----
 for(const [type,id] of [['global','*'],['group',child],['device',dev1]]){
  const view=await get(reader,type,id);check(view.status,200,`GET ${type}`);
  check(view.body.rules.length,41,`${type}: 41 rules`);check(view.body.rules.every(row=>row.origin.type==='default'&&row.override===null&&row.inherited.origin.type==='default'),true,`${type}: every origin is the default`);
  check([view.body.canEdit,view.body.reason],[false,'right'],`${type}: a Reader cannot edit`);
 }
 check(rule(await get(reader,'global','*')).effective,{enabled:true,warning:80,critical:90,level:null,durationMinutes:5,recovery:5},'default thresholds');
 let issues=await consoleIssues(owner);
 check([cpuLevel(issues,dev1),cpuLevel(issues,dev2),cpuLevel(issues,loose)],['warning','warning','warning'],'defaults: CPU 88 % is a warning everywhere');
 check(issues[dev1][0],{key:'cpu',ruleId:'cpu',level:'warning',live:true,params:{value:88}},'structured issue without text');

 // ---- Inheritance: global → parent → child → device ----
 let result=await set(owner,'global','*',{enabled:true,warning:70,critical:85});check(result.status,200,'Owner sets All devices');
 const globalAt=result.body.updatedAt;
 result=await set(parentManager,'group',parent,{enabled:true,warning:60,critical:95});check(result.status,200,'right on the group sets it');
 result=await set(parentManager,'group',child,{enabled:false,warning:50,critical:null});check(result.status,200,'right on the parent group allows the child group');
 const childAt=result.body.updatedAt;
 result=await set(deviceManager,'device',dev1,{enabled:true,warning:null,critical:50});check(result.status,200,'device right sets the device');
 const deviceAt=result.body.updatedAt;
 let view=await get(reader,'device',dev1);
 check([rule(view).origin,rule(view).inherited.origin.type,rule(view).inherited.origin.id,rule(view).override.updatedAt],[{type:'device',id:dev1,name:'DEV-1',visible:true},'group',child,deviceAt],'device: own override, inherited from the child group');
 view=await get(reader,'group',child);
 check([rule(view).origin,rule(view).inherited.origin],[{type:'group',id:child,name:'Child',visible:true},{type:'group',id:parent,name:'Parent',visible:true}],'child group: own override, inherited from the parent');
 check(rule(view).effective,{enabled:false,warning:50,critical:null,level:null,durationMinutes:5,recovery:5},'the child override is complete');
 view=await get(reader,'group',parent);
 check([rule(view).origin.type,rule(view).inherited.origin],['group',{type:'global',id:'*',name:'',visible:true}],'parent group inherits from All devices');
 view=await get(reader,'group',sibling);
 check([rule(view).origin.id,rule(view).override],[parent,null],'sibling inherits the parent value');
 view=await get(reader,'global','*');
 check([rule(view).origin.type,rule(view).override.updatedAt,rule(view).inherited.origin.type],['global',globalAt,'default'],'All devices: own override over the default');
 check(rule(view,'memory').origin.type,'default','other rules stay at the default');
 issues=await consoleIssues(owner);
 check([cpuLevel(issues,dev1),cpuLevel(issues,dev2),cpuLevel(issues,loose)],['critical','warning','critical'],'console issues follow device, parent and global settings');
 // Parent-only rights: origin outside the viewer's groups is not visible.
 view=await get(parentManager,'group',child);check(rule(view).inherited.origin.visible,true,'the parent manager sees the parent group');

 // ---- Moving a device changes its origin without any write ----
 await d.exec(sql`UPDATE device_group_members SET group_id=${child} WHERE server_id=${dev2}`);
 view=await get(reader,'device',dev2);check([rule(view).origin.type,rule(view).origin.id],['group',child],'the moved device inherits from its new group');
 issues=await consoleIssues(owner);check(cpuLevel(issues,dev2),null,'the moved device follows the disabled child rule');

 // ---- Reset ----
 result=await reset(deviceManager,'device',dev1,deviceAt);check(result.status,200,'reset the device override');
 view=await get(reader,'device',dev1);check([rule(view).origin.id,rule(view).override],[child,null],'after reset the next lower origin applies');
 issues=await consoleIssues(owner);check(cpuLevel(issues,dev1),null,'and the console follows at once');
 await refused(reset(deviceManager,'device',dev1,null),409,'ALERT_RULE_CHANGED','reset without an override');
 await refused(reset(deviceManager,'device',dev1,deviceAt),409,'ALERT_RULE_CHANGED','reset of a removed override');

 // ---- The expected fence ----
 await refused(set(parentManager,'group',child,{enabled:true,warning:40,critical:45},null),409,'ALERT_RULE_CHANGED','create while an override exists');
 await refused(set(parentManager,'group',child,{enabled:true,warning:40,critical:45},childAt-1),409,'ALERT_RULE_CHANGED','stale expected');
 result=await set(parentManager,'group',child,{enabled:true,warning:40,critical:45},childAt);check(result.status,200,'replace with the shown updated_at');
 check(result.body.updatedAt>childAt,true,'updated_at moves forward');
 await refused(set(parentManager,'group',child,{enabled:true,warning:41,critical:45},childAt),409,'ALERT_RULE_CHANGED','the old updated_at no longer matches');
 const childAt2=result.body.updatedAt;

 // ---- Rights ----
 await refused(set(viewOnly,'global','*',{enabled:true,warning:70,critical:85},globalAt),403,undefined,'no right on All devices');
 await refused(set(viewOnly,'group',parent,{enabled:true,warning:70,critical:85}),403,undefined,'no right on a group');
 await refused(set(deviceManager,'group',child,{enabled:true,warning:70,critical:85},childAt2),403,undefined,'a device right does not allow the group');
 await refused(set(reader,'device',dev2,{enabled:true,warning:70,critical:85}),403,undefined,'Reader denied');
 await refused(set(parentManager,'global','*',{enabled:true,warning:70,critical:85},globalAt),403,undefined,'a group right does not allow All devices');
 result=await set(operator,'device',dev2,{enabled:true,warning:70,critical:85});check(result.status,200,'Operator allowed');
 check([(await get(operator,'device',dev2)).body.canEdit,(await get(deviceManager,'device',dev1)).body.canEdit,(await get(deviceManager,'group',child)).body.reason],[true,true,'right'],'canEdit per scope');

 // ---- Rights before validation ----
 // Without alerts.manage on a valid scope, an invalid body still answers 403, not 400.
 for(const [label,as,scopeType,scopeId,body] of [
  ['expected not a number',viewOnly,'group',parent,{ruleId:'cpu',enabled:true,warning:80,critical:90,expected:'x'}],
  ['unknown rule',reader,'device',dev2,{ruleId:'bitlocker',enabled:true,expected:null}],
  ['warning out of range',viewOnly,'group',child,{ruleId:'cpu',enabled:true,warning:101,critical:null,durationMinutes:5,recovery:5,expected:null}],
  ['warning after critical',reader,'device',dev1,{ruleId:'cpu',enabled:true,warning:95,critical:90,durationMinutes:5,recovery:5,expected:null}],
  ['level on a threshold rule',viewOnly,'device',dev1,{ruleId:'cpu',enabled:true,warning:80,critical:90,level:'warning',durationMinutes:5,recovery:5,expected:null}],
 ])await refused(post(as,{action:'set-rule',scopeType,scopeId,...body}),403,undefined,`no right, ${label}`);
 await refused(post(viewOnly,{action:'reset-rule',scopeType:'group',scopeId:parent,ruleId:'bitlocker',expected:null}),403,undefined,'no right, reset of an unknown rule');

 // ---- Audit ----
 const rows=await auditRows();
 check(rows.map(row=>row.action),['alert-rule.set','alert-rule.set','alert-rule.set','alert-rule.set','alert-rule.reset','alert-rule.set','alert-rule.set'],'one audit row per change');
 check([rows[0].scope,rows[0].serverId,rows[0].customerId],['portal',null,null],'global: portal row without customer');
 check(JSON.parse(rows[0].target),{rule:'cpu',scope:'global',old:{enabled:true,warning:80,critical:90,level:null,durationMinutes:5,recovery:5,origin:'default'},new:{enabled:true,warning:70,critical:85,level:null,durationMinutes:5,recovery:5,origin:'global'}},'global: old and new effective settings');
 check([rows[1].scope,rows[1].serverId,rows[1].customerId],['portal',null,customerA],'group: portal row with the group customer');
 check(JSON.parse(rows[2].target).old,{enabled:true,warning:60,critical:95,level:null,durationMinutes:5,recovery:5,origin:`group:${parent}`},'child group: old value inherited from the parent');
 check([rows[3].scope,rows[3].serverId,rows[3].customerId],['device',dev1,customerA],'device: device row with its customer');
 check(JSON.parse(rows[4].target),{rule:'cpu',scope:`device:${dev1}`,old:{enabled:true,warning:null,critical:50,level:null,durationMinutes:5,recovery:5,origin:`device:${dev1}`},new:{enabled:false,warning:50,critical:null,level:null,durationMinutes:5,recovery:5,origin:`group:${child}`}},'reset: new is the inherited value');
 // A failing audit insert rolls the change back.
 await createTrigger(d,'alert_audit_fails','audit','BEFORE INSERT',{message:'audit-down',when:"NEW.action LIKE 'alert-rule.%'"});
 const beforeFailure=await overrideRows();
 result=await set(parentManager,'group',child,{enabled:true,warning:30,critical:45},childAt2);check(result.status,500,'audit failure fails the request');
 check(await overrideRows(),beforeFailure,'audit failure rolls the change back');
 await dropTrigger(d,'alert_audit_fails');

 // ---- A right lost between check and commit ----
 db.beforeNextTransaction(()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${parentAssignment}`));
 await refused(set(parentManager,'group',child,{enabled:true,warning:30,critical:45},childAt2),403,undefined,'right lost before the commit');
 await grant(parentManager,await role('Alerts on parent again',['view','alerts.manage']),'devicegroup',parent);

 // ---- Validation ----
 for(const [label,body] of [
  ['out of range',{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'cpu',enabled:true,warning:101,critical:null,expected:childAt2}],
  ['warning after critical',{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'cpu',enabled:true,warning:95,critical:90,expected:childAt2}],
  ['level on a threshold rule',{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'cpu',enabled:true,warning:80,critical:90,level:'warning',expected:childAt2}],
  ['thresholds on a boolean rule',{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'reboot-pending',enabled:true,level:'info',warning:5,expected:null}],
  ['unknown rule',{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'bitlocker',enabled:true,expected:null}],
  ['unknown scope type',{action:'set-rule',scopeType:'tenant',scopeId:customerA,ruleId:'cpu',enabled:true,warning:80,expected:null}],
  ['global with an id',{action:'set-rule',scopeType:'global',scopeId:child,ruleId:'cpu',enabled:true,warning:80,expected:null}],
  ['expected not a number',{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'cpu',enabled:true,warning:80,expected:'x'}],
  ['reset of an unknown rule',{action:'reset-rule',scopeType:'group',scopeId:child,ruleId:'bitlocker',expected:childAt2}],
 ])await refused(post(parentManager,body),400,'ALERT_RULE_INVALID',label);
 result=await set(parentManager,'group',child,{enabled:true,level:'critical'},null,'reboot-pending');check(result.status,200,'boolean rule with a level');
 check(rule(await get(reader,'device',dev1),'reboot-pending').effective,{enabled:true,warning:null,critical:null,level:'critical',durationMinutes:null,recovery:null},'the device inherits the boolean level');

 // ---- Minimum duration and recovery margin ----
 let current=rule(await get(reader,'group',child));
 result=await post(parentManager,{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'cpu',enabled:true,warning:40,critical:45,durationMinutes:10,recovery:3,expected:current.override.updatedAt});check(result.status,200,'set-rule with a minimum duration and margin');
 current=rule(await get(reader,'group',child));
 check([current.effective,current.override.durationMinutes,current.override.recovery],[{enabled:true,warning:40,critical:45,level:null,durationMinutes:10,recovery:3},10,3],'both are stored and resolved');
 check((await overrideRows()).find(row=>row.rule_id==='cpu'&&row.scope_id===child).duration_minutes,10,'the column duration_minutes');
 const last=(await auditRows()).at(-1);
 check(JSON.parse(last.target),{rule:'cpu',scope:`group:${child}`,old:{enabled:true,warning:40,critical:45,level:null,durationMinutes:5,recovery:5,origin:`group:${child}`},new:{enabled:true,warning:40,critical:45,level:null,durationMinutes:10,recovery:3,origin:`group:${child}`}},'the audit has both fields in old and new');
 for(const [label,values] of [['missing duration',{recovery:3}],['duration above 1440',{durationMinutes:1441,recovery:3}],['margin not below the threshold',{durationMinutes:0,recovery:40}],['negative margin',{durationMinutes:0,recovery:-1}]])
  await refused(post(parentManager,{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'cpu',enabled:true,warning:40,critical:45,...values,expected:current.override.updatedAt}),400,'ALERT_RULE_INVALID',label);
 await refused(post(parentManager,{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'reboot-pending',enabled:true,level:'info',durationMinutes:5,expected:rule(await get(reader,'group',child),'reboot-pending').override.updatedAt}),400,'ALERT_RULE_INVALID','a minimum duration on a boolean rule');
 await refused(post(parentManager,{action:'set-rule',scopeType:'group',scopeId:child,ruleId:'disk-free',enabled:true,warning:95,critical:5,durationMinutes:0,recovery:10,expected:null}),400,'ALERT_RULE_INVALID','disk-free threshold and margin above 100 %');

 // ---- One overrides statement in the console, whatever the number of devices ----
 let statements=0;const counting=(text)=>{if(/alert_rule_overrides/.test(text))statements++;};
 db.hooks.statement=counting;await consoleIssues(owner);db.hooks.statement=null;
 check(statements,1,'the console reads the overrides of all visible devices in one statement');

 // ---- Customer boundary once a second customer exists ----
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 check((await get(technician,'group',groupB)).status,404,'customer B group answers 404');
 check((await get(technician,'device',devB)).status,404,'customer B device answers 404');
 await refused(set(technician,'group',groupB,{enabled:true,warning:70,critical:85}),404,undefined,'set on a customer B group');
 await refused(set(technician,'device',devB,{enabled:true,warning:70,critical:85}),404,undefined,'set on a customer B device');
 await refused(set(technician,'global','*',{enabled:true,warning:75,critical:85},globalAt),403,'ALERT_RULE_SCOPE_BOUNDARY','All devices with an unseen customer');
 // The boundary also comes before the body.
 await refused(post(technician,{action:'set-rule',scopeType:'group',scopeId:groupB,ruleId:'cpu',enabled:true,warning:101,critical:null,durationMinutes:5,recovery:5,expected:'x'}),404,undefined,'invalid body on a customer B group');
 await refused(post(technician,{action:'reset-rule',scopeType:'device',scopeId:devB,ruleId:'bitlocker',expected:null}),404,undefined,'invalid reset on a customer B device');
 await refused(post(technician,{action:'set-rule',scopeType:'global',scopeId:'*',ruleId:'bitlocker',enabled:true,expected:'x'}),403,'ALERT_RULE_SCOPE_BOUNDARY','invalid body on All devices with an unseen customer');
 view=await get(technician,'global','*');check([view.status,view.body.canEdit,view.body.reason],[200,false,'customer-boundary'],'All devices stays readable, edit blocked by the boundary');
 result=await set(technician,'group',parent,{enabled:true,warning:65,critical:95},(await get(technician,'group',parent)).body.rules[0].override.updatedAt);check(result.status,200,'technician changes a group of customer A');
 result=await set(owner,'global','*',{enabled:true,warning:75,critical:85},globalAt);check(result.status,200,'Owner changes All devices with a second customer');

 // ---- Cleanup triggers ----
 const empty=await group('Empty',null);await set(owner,'group',empty,{enabled:false});
 check((await d.query(sql`SELECT 1 FROM alert_rule_overrides WHERE scope_id=${empty}`)).length,1,'group override exists');
 await d.exec(sql`DELETE FROM device_groups WHERE id=${empty}`);
 check((await d.query(sql`SELECT 1 FROM alert_rule_overrides WHERE scope_id=${empty}`)).length,0,'deleting the group deletes its overrides');
 check((await d.query(sql`SELECT 1 FROM alert_rule_overrides WHERE scope_id=${dev2}`)).length,1,'device override exists');
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${dev2}`);
 check((await d.query(sql`SELECT 1 FROM alert_rule_overrides WHERE scope_id=${dev2}`)).length,0,'removing the device deletes its overrides');
 console.log(`PASS alert rule overrides (${checks} checks): inheritance over global, parent, child and device in the rule table and the console issues, moving, reset, expected fence, rights, customer boundary, audit with rollback, validation, minimum duration and recovery margin, cleanup triggers and one overrides query.`);
}finally{await d.close();}
