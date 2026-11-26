// Alarms against PostgreSQL through the real routes and lib/server/devices/alerts.ts: real
// POST /api/heartbeat calls open and close an alarm with the minimum duration and
// recovery margin of an override (also one of the device customer only), the periodic check (runAlertSweep) with its
// lease, parallel evaluations of one device, the open alarms of GET /api/console
// in one statement, acknowledge, mute and unmute with their audit rows, the
// refusals, the customer boundary, a right lost before the commit, an audit
// failure, the history API, the revoke trigger and the migration backfill.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {copyFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {createDatabase,sql} from '../../runtime/database.mjs';
import {createTestDatabase} from '../support/postgres.mjs';
import {migrateDatabase} from '../../scripts/selfhost.mjs';
import {boundaryPhase,everyCustomer} from '../support/customer-separation.mjs';

const uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100';
const minute=60_000;
let viewer=null,checks=0,clock=Date.UTC(2026,9,20,9,0,0);
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
const HttpError=realHttpError;
const d=await sourceDatabase(),db=hookDatabase(d);
const body=async request=>{const text=await request.text();try{return JSON.parse(text);}catch{throw new HttpError(400,serverText('apiError.request.invalidJson'));}};
const server={db:()=>db,now:()=>clock,config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
 body,sameOrigin:()=>{},requireViewer:async()=>stamped({...viewer}),log:async()=>{},
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
const access=load('lib/server/identity/access.ts',imports),alerts=load('lib/server/devices/alerts.ts',imports),health=load('ui/base/health-score.ts',imports);
const consoleApi=load('app/api/console/route.ts',imports),alertsApi=load('app/api/alerts/route.ts',imports),heartbeatApi=load('app/api/heartbeat/route.ts',imports);

const time=clock;
const insert=(table,row)=>insertRow(d,table,row);
async function persona(name){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@alarms.test',display_name:name,auth_principal:principal,auth_email:name+'@alarms.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@alarms.test',principal});
}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){const id=uuid();await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${id},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);return id;}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};

// Agents: a pinned key and a token per device; the heartbeat runs the real token SQL.
const agentKey=()=>{const jwk=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});return {jwk,pinned:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e})};};
const telemetry=(key,values={})=>({hostname:'VM',os:'Microsoft Windows Server 2025 Standard',build:'26100',manufacturer:'Microsoft',model:'VM',domain:'WORKGROUP',cores:4,memoryGb:8,cpu:10,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.6.7',mode:'Management',publicKey:{kty:'RSA',n:key.jwk.n,e:key.jwk.e},agentCapabilities:['refresh'],...values});
const agents=new Map();
async function device(name,{groupId=null,customer=customerA,lastSeen=clock-30_000,values={}}={}){
 const id=uuid(),token=crypto.randomBytes(32).toString('hex'),key=agentKey();
 await insert('servers',{id,name,token_hash:sha(token),token_expires_at:time+365*24*60*minute,created_at:time,last_seen:lastSeen,management:1,snapshot:lastSeen===null?null:JSON.stringify(telemetry(key,values)),agent_public_key:key.pinned,customer_id:customer});
 if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});
 agents.set(id,{token,key});return id;
}
const beat=async(id,values={})=>{
 const {token,key}=agents.get(id);
 const response=await heartbeatApi.POST(new Request('https://alarms.test/api/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({serverId:id,snapshot:telemetry(key,values),results:[],runningJobs:[]})}));
 assert.equal(response.status,200,`heartbeat ${JSON.stringify(await response.clone().json())}`);
};
const override=(ruleId,scopeType,scopeId,settings)=>insert('alert_rule_overrides',{id:uuid(),rule_id:ruleId,scope_type:scopeType,scope_id:scopeId,enabled:1,warning:null,critical:null,level:null,duration_minutes:null,recovery:null,actor:'fixture',updated_at:time,...settings});

const rows=(serverId,extra=sql`TRUE`)=>d.query(sql`SELECT id,rule_id AS "ruleId",key,state,level,peak_level AS "peakLevel",peak_value AS "peakValue",threshold,started_at AS "startedAt",opened_at AS "openedAt",closed_at AS "closedAt",close_reason AS "closeReason",acknowledged_at AS "acknowledgedAt",muted_until AS "mutedUntil" FROM alerts WHERE server_id=${serverId} AND ${extra} ORDER BY started_at,rule_id`);
const brief=list=>list.map(row=>[row.ruleId,row.state,row.level,row.closeReason]);
const post=async(as,payload)=>{viewer=as;const response=await alertsApi.POST(new Request('https://alarms.test/api/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
const history=async(as,query)=>{viewer=as;const response=await alertsApi.GET(new Request(`https://alarms.test/api/alerts?${query}`));return {status:response.status,cache:response.headers.get('Cache-Control'),body:await response.json()};};
const consoleData=async as=>{viewer=as;const response=await consoleApi.GET(new Request('https://alarms.test/api/console'));assert.equal(response.status,200,'console GET');return response.json();};
const auditRows=()=>d.query(sql`SELECT action,target,scope,server_id AS "serverId" FROM audit WHERE action LIKE 'alert.%' ORDER BY id`);
const alertState=id=>d.one(sql`SELECT state,level,acknowledged_at AS "acknowledgedAt",acknowledged_by AS "acknowledgedBy",muted_until AS "mutedUntil",muted_by AS "mutedBy" FROM alerts WHERE id=${id}`);
async function refused(promise,status,code,label,id){
 const [beforeState,beforeAudit]=await Promise.all([id?alertState(id):null,auditRows()]);
 const result=await promise;
 check(result.status,status,label);if(code!==undefined)check(result.body.code,code,label+' code');
 if(id)check(await alertState(id),beforeState,label+' leaves the alarm unchanged');
 check((await auditRows()).length,beforeAudit.length,label+' writes no audit row');
 return result;
}

try{
 // ---- Fixture ----
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const groupA=await group('A',null),groupB=await group('B',null,customerB);
 const owner=await persona('owner'),operator=await persona('operator'),reader=await persona('reader'),technician=await persona('technician'),manager=await persona('manager');
 await grant(owner,await role('Owner',['*']),'global');
 await grant(operator,await role('Operator',access.rolePermissions.operator),'global');
 await grant(reader,await role('Reader',access.rolePermissions.viewer),'global');
 await grant(technician,await role('Technician',['view','alerts.manage']),'global');
 check(load('lib/i18n/translate.ts').translate('de',access.permissionDefinitions.find(entry=>entry.id==='alerts.manage').labelKey),'Alarmregeln und Alarme verwalten','the right covers rules and alarms');

 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 // ---- Heartbeats: minimum duration and recovery margin from an override ----
 const web=await device('WEB',{groupId:groupA});
 await override('cpu','group',groupA,{warning:80,critical:90,duration_minutes:2,recovery:5});
 clock+=minute;await beat(web,{cpu:85});
 check(brief(await rows(web)),[['cpu','pending','warning',null]],'the first heartbeat over the threshold creates a pending alarm');
 clock+=minute;await beat(web,{cpu:95});
 check(brief(await rows(web)),[['cpu','pending','critical',null]],'still pending after one minute');
 clock+=minute;await beat(web,{cpu:93});
 const list=await rows(web);
 check([brief(list),Number(list[0].openedAt),list[0].peakValue,list[0].peakLevel,list[0].threshold],[[['cpu','open','critical',null]],clock,95,'critical',90],'opens after the group override duration of 2 minutes with peak and threshold');
 clock+=minute;await beat(web,{cpu:76});
 check(brief(await rows(web)),[['cpu','open','critical',null]],'76 % is inside the band (T 80 − r 5): stays open with its level');
 clock+=minute;await beat(web,{cpu:74});
 check(brief(await rows(web)),[['cpu','closed','critical','recovered']],'74 % closes it as recovered');
 clock+=minute;await beat(web,{cpu:74});
 check((await rows(web)).length,1,'an unchanged heartbeat writes nothing new');

 // ---- A threshold that comes only from a customer override (the syncAlertBatch path) ----
 const customerDevice=await device('CUSTOMER-B',{customer:customerB});
 await override('cpu','customer',customerB,{warning:50,critical:95,duration_minutes:0,recovery:5});
 clock+=minute;await beat(customerDevice,{cpu:60});
 check(brief(await rows(customerDevice)),[['cpu','open','warning',null]],'CPU 60 % opens an alarm on a device without group through its customer threshold of 50 %');
 check(brief(await rows(web)),[['cpu','closed','critical','recovered']],'the customer override of customer B does not reach a device of customer A');
 clock+=minute;await beat(customerDevice,{cpu:40});
 check(brief(await rows(customerDevice)),[['cpu','closed','warning','recovered']],'40 % (below 50 − 5) closes it as recovered');

 // ---- A failing alarm update never fails the heartbeat ----
 await createTrigger(d,'alerts_insert_fails','alerts','BEFORE INSERT',{message:'alerts-down'});
 const logged=[],error=console.error;console.error=(...parts)=>logged.push(parts.join(' '));
 try{clock+=minute;await beat(web,{cpu:99,rebootPending:true});}finally{console.error=error;}
 check(logged.length,1,'the failure is logged once');
 check(/alerts-down/.test(logged[0])&&!/hostname|VM/.test(logged[0]),true,'the log names the error and no snapshot data');
 await dropTrigger(d,'alerts_insert_fails');

 // ---- Periodic check: lease, offline alarm, no-data, a pending alarm opens without data ----
 const db1=await device('DB-1',{groupId:groupA});
 await override('reboot-pending','device',db1,{level:'critical'});
 clock+=minute;await beat(db1,{cpu:99,rebootPending:true});
 check(brief(await rows(db1)),[['cpu','pending','critical',null],['reboot-pending','open','critical',null]],'a heartbeat opens the reboot alarm, CPU waits');
 clock+=2*minute+5000;
 let sweep=await alerts.runAlertSweep(clock);
 check([sweep.status,sweep.failed],['ran',0],'the sweep runs');
 check(brief(await rows(db1)),[['reboot-pending','open','critical',null]],'2 minutes without a heartbeat: the device is offline, the pending live alarm is deleted and the reboot alarm stays');
 check((await alerts.runAlertSweep(clock+49_999)).status,'skipped','a second sweep within 50 s does not run');
 check((await alerts.runAlertSweep(clock+50_000)).status,'ran','after 50 s it runs again');
 clock+=50_000;
 // An open live alarm on a device that stops sending.
 const app=await device('APP',{groupId:groupA});
 await override('memory','device',app,{warning:80,critical:90,duration_minutes:0,recovery:5});
 clock+=minute;await beat(app,{memory:95});
 check(brief(await rows(app)),[['memory','open','critical',null]],'duration 0 opens at once');
 // A pending alarm opens through the sweep without new data.
 const pendingDevice=await device('PENDING',{groupId:groupA});
 await override('memory','device',pendingDevice,{warning:80,critical:90,duration_minutes:1,recovery:5});
 await beat(pendingDevice,{memory:85});
 clock+=minute+1000;
 sweep=await alerts.runAlertSweep(clock);
 check(brief(await rows(pendingDevice)),[['memory','open','warning',null]],'the sweep opens the pending alarm once its duration has passed');
 clock+=15*minute;
 sweep=await alerts.runAlertSweep(clock);
 check(brief(await rows(app)),[['memory','closed','critical','no-data'],['device-offline','open','critical',null]],'15 minutes without a heartbeat: Device offline opens and the live alarm closes with no-data');
 const offline=(await rows(app)).find(row=>row.ruleId==='device-offline');
 check([offline.peakValue,offline.threshold],[16,15],'the offline peak is the minutes since the last heartbeat');
 clock+=minute;await beat(app,{memory:20});
 check(brief(await rows(app,sql`rule_id='device-offline'`)),[['device-offline','closed','critical','recovered']],'a later heartbeat closes the offline alarm');

 // ---- Concurrency: parallel evaluations of one device ----
 const busy=await device('BUSY',{groupId:groupA,values:{rebootPending:true,cpu:97}});
 await override('cpu','device',busy,{warning:80,critical:90,duration_minutes:0,recovery:5});
 await Promise.all(Array.from({length:6},()=>alerts.syncDeviceAlerts(busy,clock)));
 const active=await d.query(sql`SELECT rule_id,key,count(*)::int AS n FROM alerts WHERE server_id=${busy} AND state<>'closed' GROUP BY rule_id,key ORDER BY rule_id`);
 check(active.map(row=>[row.rule_id,row.n]),[['cpu',1],['reboot-pending',1]],'parallel evaluations leave exactly one alarm per rule and key');
 const removedDevice=await device('REMOVED',{values:{rebootPending:true}});
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${removedDevice}`);
 await alerts.syncDeviceAlerts(removedDevice,clock);
 check((await rows(removedDevice)).length,0,'a removed device gets no alarms');

 // ---- Console: open alarms only, one statement ----
 const devB=await device('DEV-B',{groupId:groupB,customer:customerB,values:{rebootPending:true}});
 await alerts.syncDeviceAlerts(devB,clock);
 const pendingOnly=await device('PENDING-ONLY',{groupId:groupA,values:{cpu:99}});
 await alerts.syncDeviceAlerts(pendingOnly,clock);
 check(brief(await rows(pendingOnly)),[['cpu','pending','critical',null]],'a pending alarm exists');
 let statements=0;db.hooks.statement=text=>{if(/\bFROM alerts\b/.test(text))statements++;};
 let data=await consoleData(owner);db.hooks.statement=null;
 check(statements,1,'the console reads the alarms of all visible devices in one statement');
 const byId=Object.fromEntries(data.servers.map(item=>[item.id,item.alerts]));
 check(byId[pendingOnly],[],'pending alarms are not in the console data');
 check(byId[web].map(item=>item.ruleId).sort(),['device-offline','reboot-pending'],'the sweep caught up the failed heartbeat (reboot) and opened Device offline; the closed CPU alarm is not in the console data');
 const busyCpu=byId[busy].find(item=>item.ruleId==='cpu');
 check(Object.keys(busyCpu),['id','ruleId','key','level','peakLevel','peakValue','threshold','params','startedAt','openedAt','acknowledged','muted'],'the fields of an open alarm');
 check([busyCpu.level,busyCpu.peakValue,busyCpu.threshold,busyCpu.params,busyCpu.acknowledged,busyCpu.muted],['critical',97,90,{value:97},null,null],'its values');

 // ---- Acknowledge, mute, re-mute, unmute ----
 const alarm=busyCpu.id;
 let result=await post(operator,{action:'acknowledge',id:alarm});check(result.status,200,'Operator acknowledges');
 let audit=await auditRows();
 check([audit.length,audit[0].action,audit[0].scope,audit[0].serverId],[1,'alert.acknowledge','device',busy],'one device audit row');
 check(JSON.parse(audit[0].target),{alert:alarm,rule:'cpu',key:'cpu',level:'critical'},'the acknowledge target');
 check([(await alertState(alarm)).acknowledgedBy,Number((await alertState(alarm)).acknowledgedAt)],['operator@alarms.test',clock],'stored with actor and time');
 await refused(post(technician,{action:'acknowledge',id:alarm}),409,'ALERT_STATE_CHANGED','a second acknowledge',alarm);
 await refused(post(technician,{action:'unmute',id:alarm}),409,'ALERT_STATE_CHANGED','unmute without a mute',alarm);
 result=await post(technician,{action:'mute',id:alarm,minutes:60});check([result.status,result.body.mutedUntil],[200,clock+60*minute],'mute for 1 hour');
 audit=await auditRows();
 check(JSON.parse(audit.at(-1).target),{alert:alarm,rule:'cpu',key:'cpu',level:'critical',mutedUntil:new Date(clock+60*minute).toISOString(),minutes:60,previousMutedUntil:null},'the mute target');
 const firstMute=clock+60*minute;
 clock+=minute;
 result=await post(technician,{action:'mute',id:alarm,minutes:240});check(result.status,200,'mute again replaces the end');
 check([Number((await alertState(alarm)).mutedUntil),JSON.parse((await auditRows()).at(-1).target).previousMutedUntil],[clock+240*minute,new Date(firstMute).toISOString()],'re-mute: new end and the previous one in the audit');
 const secondMute=clock+240*minute;
 result=await post(technician,{action:'unmute',id:alarm});check(result.status,200,'unmute');
 check([(await alertState(alarm)).mutedUntil,JSON.parse((await auditRows()).at(-1).target)],[null,{alert:alarm,rule:'cpu',key:'cpu',level:'critical',previousMutedUntil:new Date(secondMute).toISOString()}],'the unmute target');
 check((await auditRows()).map(row=>row.action),['alert.acknowledge','alert.mute','alert.mute','alert.unmute'],'exactly one audit row per action');
 await refused(post(technician,{action:'unmute',id:alarm}),409,'ALERT_STATE_CHANGED','unmute twice',alarm);
 for(const [label,payload] of [['invalid minutes',{action:'mute',id:alarm,minutes:30}],['minutes as text',{action:'mute',id:alarm,minutes:'60'}],['unknown action',{action:'close',id:alarm}],['invalid id',{action:'acknowledge',id:'x'}]])
  await refused(post(technician,payload),400,'ALERT_INVALID',label,alarm);
 await refused(post(technician,{action:'acknowledge',id:uuid()}),404,undefined,'an unknown alarm');
 await refused(post(reader,{action:'mute',id:alarm,minutes:60}),403,undefined,'Reader: view without alerts.manage',alarm);
 const closedAlarm=(await rows(web))[0].id;
 await refused(post(technician,{action:'acknowledge',id:closedAlarm}),409,'ALERT_STATE_CHANGED','a closed alarm',closedAlarm);
 const pendingAlarm=(await rows(pendingOnly))[0].id;
 await refused(post(technician,{action:'acknowledge',id:pendingAlarm}),404,undefined,'a pending alarm answers like an unknown one',pendingAlarm);
 // A mute whose time is up is null in the console.
 result=await post(technician,{action:'mute',id:alarm,minutes:60});
 clock+=60*minute;
 data=await consoleData(owner);
 check(data.servers.find(item=>item.id===busy).alerts.find(item=>item.id===alarm).muted,null,'muted is null once its time is up');
 await refused(post(technician,{action:'unmute',id:alarm}),409,'ALERT_STATE_CHANGED','unmute of an expired mute',alarm);
 check((await alertState(alarm)).acknowledgedBy,'operator@alarms.test','the acknowledgement stays');

 // ---- Escalation clears the acknowledgement ----
 const memoryHost=await device('MEM',{groupId:groupA,values:{memory:85}});
 await override('memory','device',memoryHost,{warning:80,critical:90,duration_minutes:0,recovery:5});
 await alerts.syncDeviceAlerts(memoryHost,clock);
 const memoryAlarm=(await rows(memoryHost))[0].id;
 await post(technician,{action:'acknowledge',id:memoryAlarm});
 await d.exec(sql`UPDATE servers SET snapshot=${JSON.stringify(telemetry(agents.get(memoryHost).key,{memory:95}))} WHERE id=${memoryHost}`);
 await alerts.syncDeviceAlerts(memoryHost,clock);
 check([(await alertState(memoryAlarm)).level,(await alertState(memoryAlarm)).acknowledgedAt],['critical',null],'warning → critical clears the acknowledgement');

 // ---- A right lost before the commit; an audit failure ----
 const assignment=await grant(manager,await role('Alerts manager',['view','alerts.manage']),'device',memoryHost);
 db.beforeNextTransaction(()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${assignment}`));
 await refused(post(manager,{action:'acknowledge',id:memoryAlarm}),404,undefined,'a right lost before the commit',memoryAlarm);
 await createTrigger(d,'alarm_audit_fails','audit','BEFORE INSERT',{message:'audit-down',when:"NEW.action LIKE 'alert.%'"});
 result=await refused(post(technician,{action:'acknowledge',id:memoryAlarm}),500,undefined,'an audit failure',memoryAlarm);
 await dropTrigger(d,'alarm_audit_fails');

 // ---- History API ----
 const historyRows=await history(owner,`serverId=${web}`);
 check([historyRows.status,historyRows.cache],[200,'no-store'],'history answers with no-store');
 const appHistory=await history(owner,`serverId=${app}&limit=1`);
 check([appHistory.body.alerts.length,appHistory.body.alerts[0].ruleId,appHistory.body.alerts[0].state,appHistory.body.alerts[0].closeReason],[1,'device-offline','closed','recovered'],'newest start first');
 check(Object.keys(appHistory.body.alerts[0]).slice(-3),['state','closedAt','closeReason'],'the history fields');
 const page2=await history(owner,`serverId=${app}&limit=1&before=${encodeURIComponent(appHistory.body.next)}`);
 check([page2.body.alerts.map(row=>row.ruleId),page2.body.next],[['memory'],null],'the cursor gives the next page and ends');
 const pendingHistory=await history(owner,`serverId=${pendingOnly}`);
 check(pendingHistory.body,{alerts:[],next:null},'no pending rows in the history');
 for(const query of [`serverId=${app}&limit=0`,`serverId=${app}&limit=101`,`serverId=${app}&before=1:x`,'serverId=x'])check((await history(owner,query)).body.code,'ALERT_INVALID',`400 for ${query}`);

 // ---- Customer boundary once a second customer exists ----
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 const alarmB=(await rows(devB))[0].id;
 // B's device gets a critical alarm, so a leak would put it at the top of the Problems tab.
 await d.exec(sql`UPDATE alerts SET level='critical',peak_level='critical' WHERE id=${alarmB}`);
 await refused(post(technician,{action:'acknowledge',id:alarmB}),404,undefined,"customer B's alarm",alarmB);
 await refused(post(technician,{action:'mute',id:alarmB,minutes:60}),404,undefined,"mute of customer B's alarm",alarmB);
 check((await history(technician,`serverId=${devB}`)).status,404,"customer B's device history");
 data=await consoleData(technician);
 check([data.servers.some(item=>item.id===devB),data.servers.flatMap(item=>item.alerts).some(item=>item.id===alarmB)],[false,false],"customer B's alarms are not in A's console data");
 // The health and the Problems tab run in the browser on exactly this data (ui/base/health-score.ts).
 const technicianRows=health.problemRows(data.servers);
 check([technicianRows.length>0,technicianRows.every(row=>row.device.customerId===customerA),technicianRows.some(row=>row.device.id===devB||row.reasons.some(item=>item.id===alarmB))],[true,true,false],"A's Problems tab lists only A's devices and never B's alarm");
 check(data.servers.every(item=>item.customerId===customerA&&health.deviceHealth(item).counts.critical===(item.alerts??[]).filter(alarm=>alarm.level==='critical').length),true,"A's health counts only A's alarms");
 const ownerData=await consoleData(owner),ownerRow=health.problemRows(ownerData.servers).find(row=>row.device.id===devB);
 check([ownerRow?.health.state,ownerRow?.reasons.map(item=>item.id)],['critical',[alarmB]],"the Owner's Problems tab has B's device with its critical alarm");
 check(health.problemRows(ownerData.servers).some(row=>row.device.customerId===customerA),true,"and A's devices");
 check((await post(owner,{action:'acknowledge',id:alarmB})).status,200,'the Owner sees every customer');

 // ---- Revoke trigger ----
 check((await rows(busy)).length>0,true,'alarms exist');
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${busy}`);
 check((await rows(busy)).length,0,'removing the device deletes its alarms');

 // ---- Migration backfill of an existing override row ----
 {
  const directory=await mkdtemp(path.join(os.tmpdir(),'serverdesk-alarms-'));
  const target=await createTestDatabase({template:false});
  const fresh=createDatabase({url:target.url,password:target.password,max:2,idleTimeoutSeconds:1});
  try{
   const migrations=path.resolve('drizzle');
   for(const name of (await readdir(migrations)).filter(name=>/^000[0-4]_.+\.sql$/.test(name)))await copyFile(path.join(migrations,name),path.join(directory,name));
   await migrateDatabase(fresh,{directory});
   for(const [id,ruleId,scopeType,scopeId] of [[uuid(),'cpu','global','*'],[uuid(),'disk-free','global','*'],[uuid(),'reboot-pending','global','*']])
    await fresh.exec(sql`INSERT INTO alert_rule_overrides(id,rule_id,scope_type,scope_id,enabled,warning,critical,level,actor,updated_at) VALUES(${id},${ruleId},${scopeType},${scopeId},1,${ruleId==='reboot-pending'?null:70}::integer,NULL,${ruleId==='reboot-pending'?'info':null}::text,'fixture',${time})`);
   await migrateDatabase(fresh);
   const backfilled=await fresh.query(sql`SELECT rule_id,duration_minutes,recovery FROM alert_rule_overrides ORDER BY rule_id`);
   check(backfilled.map(row=>[row.rule_id,row.duration_minutes,row.recovery]),[['cpu',5,5],['disk-free',0,2],['reboot-pending',null,null]],'existing overrides get the catalog defaults; boolean rules keep null');
   check((await fresh.one(sql`SELECT last_started_at FROM alert_sweep WHERE id=1`)).last_started_at,null,'the lease row exists');
  }finally{await fresh.close();await target.drop();await rm(directory,{recursive:true,force:true});}
 }

 console.log(`PASS alarms (${checks} checks): heartbeats open and close with duration and recovery from overrides, a failing alarm update keeps the heartbeat, the sweep with lease, offline alarm, no-data and pending alarms, parallel evaluations, console alarms in one statement, acknowledge, mute and unmute with audit, refusals, escalation, a lost right and an audit failure, the history API, the customer boundary, the revoke trigger and the migration backfill.`);
}finally{await d.close();}
