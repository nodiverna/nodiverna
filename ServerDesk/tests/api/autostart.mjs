// Autostart on PostgreSQL: POST /api/agent/autostart (baseline, new entries,
// changed command, removed and truncated reports, refusals, parallel reports),
// the console summary in one statement, the rules autostart-new and
// autostart-new-suspicious, GET/POST /api/autostart/device (rights, Reader and
// Operator, customer boundary, 409 codes, one audit row, rollback on a failing
// audit insert), GET /api/autostart (rare entries first, boundary) and the drift
// category autostart.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import '../support/register.mjs';
import {boundaryPhase,everyCustomer} from '../support/customer-separation.mjs';

const uuid=()=>crypto.randomUUID();
const customerA='00000000-0000-4000-8000-000000000100';
let viewer=null,clock=Date.now(),checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
const HttpError=realHttpError;
// `counted` counts the statements of the console summary.
const counted={on:false,statements:0};
const d=await sourceDatabase(),db=hookDatabase(d,{statement:()=>{if(counted.on)counted.statements++;}});
const server={db:()=>db,now:()=>clock,config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
 body:async(request,limit=256000)=>{const text=await request.text();if(Buffer.byteLength(text)>limit)throw new HttpError(413,'Anfrage zu groß.');return JSON.parse(text);},
 sameOrigin:()=>{},requireViewer:async()=>stamped({...viewer}),log:async()=>{},
 failure:error=>error instanceof HttpError?Response.json({error:error.message,code:error.code,messageKey:error.messageKey},{status:error.status}):Response.json({error:'Interner Fehler.',code:'INTERNAL_ERROR'},{status:500})};
const mfa={requireLiveSessions:async()=>{},requireMfa:async()=>{},isMfaEnabled:async()=>true,mfaSessionFence:async()=>sql`TRUE`,readMfaManagementProof:async()=>({guard:sql`TRUE`})};
const tokens=new Map();
const v3={agentFromBearer:async request=>{const token=(request.headers.get('authorization')??'').replace(/^Bearer /,'');const id=tokens.get(token);if(!id)throw new HttpError(401,'Agent nicht freigegeben.');return {id};},maintenanceBusy:async()=>false};
const alerts={syncDeviceAlerts:async()=>{}};
const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../identity/mfa':mfa,'./mfa':mfa,'./identity/mfa':mfa,'@/lib/server/identity/mfa':mfa,'@/lib/server/agent/agent-protocol':v3,'./agent-protocol':v3,'../agent/agent-protocol':v3,'@/lib/server/devices/alerts':alerts,'../devices/alerts':alerts,'./alerts':alerts};
const load=sourceLoader();
const inventory=load('lib/autostart-inventory.ts',imports),autostartLib=load('lib/server/devices/autostart.ts',imports);
const agentApi=load('app/api/agent/autostart/route.ts',imports),fleetApi=load('app/api/autostart/route.ts',imports),deviceApi=load('app/api/autostart/device/route.ts',imports);
const {defaultAlertSettings,evaluateAlertRules}=await import('../../lib/alert-rules.ts');
const {deviceIssues}=await import('../../ui/base/ui-device.ts');
const {driftPolicySchema}=await import('../../lib/server/automation/drift.ts');

const time=Date.now(),insert=(table,row)=>insertRow(d,table,row);
async function persona(name){const id=uuid(),principal='local:'+id;await insert('local_users',{id,username:name,email:name+'@as.test',display_name:name,auth_principal:principal,auth_email:name+'@as.test',status:'active',auth_version:1,created_at:time,updated_at:time});return stamped({id,userId:id,label:name+'@as.test',principal});}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};
async function device(name,groupId,customer=customerA){const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,snapshot:null,customer_id:customer});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});tokens.set('token-'+id,id);return id;}

const entry=async(name,command,extra={})=>{const value={category:'run',scope:'machine',location:'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',name,command,target:`C:\\Program Files\\${name}\\${name}.exe`,signature:'valid',signer:'Contoso Ltd',publisher:'Contoso',microsoft:false,userPath:false,...extra};return {id:await inventory.autostartId(value),...value};};
const report=async(items,{count=items.length,truncated=count>items.length,checksum}={})=>({checksum:checksum??await inventory.autostartChecksum(items),count,truncated,items});
const send=async(id,body,{token='token-'+id,raw}={})=>{const response=await agentApi.POST(new Request('https://as.test/api/agent/autostart',{method:'POST',headers:{'Content-Type':'application/json',authorization:'Bearer '+token},body:raw??JSON.stringify({serverId:id,...body})}));return {status:response.status,body:await response.json()};};
const stored=id=>d.query(sql`SELECT name,command,baseline,first_seen AS "firstSeen",acknowledged_at AS "acknowledgedAt",acknowledged_by AS "acknowledgedBy" FROM device_autostart WHERE server_id=${id} ORDER BY name,command`);
const fleet=async(as,params)=>{viewer=as;const response=await fleetApi.GET(new Request('https://as.test/api/autostart?'+new URLSearchParams(params)));return {status:response.status,body:await response.json()};};
const deviceView=async(as,id)=>{viewer=as;const response=await deviceApi.GET(new Request('https://as.test/api/autostart/device?id='+id));return {status:response.status,body:await response.json()};};
const confirm=async(as,body)=>{viewer=as;const response=await deviceApi.POST(new Request('https://as.test/api/autostart/device',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
const audits=()=>d.query(sql`SELECT actor,target,server_id AS "serverId",scope FROM audit WHERE action='autostart.confirm' ORDER BY id`);
const later=(ms=61000)=>{clock+=ms;};

try{
 // ---- Fixture ----
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const parent=await group('Parent',null),groupB=await group('B group',null,customerB);
 const dev1=await device('DEV-1',parent),dev2=await device('DEV-2',parent),devB=await device('DEV-B',groupB,customerB);
 const owner=await persona('owner'),reader=await persona('reader'),operator=await persona('operator'),viewOnly=await persona('view-only'),technician=await persona('technician');
 await grant(owner,await role('Owner',['*']),'global');
 // The permissions of the built-in roles Reader and Operator (lib/server/identity/rbac.ts builtinRoles, from lib/server/identity/access.ts).
 const {rolePermissions}=load('lib/server/identity/access.ts',imports);
 await grant(reader,await role('Reader',rolePermissions.viewer),'global');
 await grant(operator,await role('Operator',rolePermissions.operator),'global');
 await grant(technician,await role('Technician',rolePermissions.operator),'global');
 await grant(viewOnly,await role('Viewer',['view']),'global');

 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 // ---- Ingest: baseline ----
 const agent=await entry('ContosoAgent','"C:\\Program Files\\ContosoAgent\\ContosoAgent.exe" /background');
 const updater=await entry('ContosoUpdater','"C:\\Program Files\\ContosoUpdater\\ContosoUpdater.exe"');
 const first=await report([agent,updater]);
 check(await autostartLib.autostartResyncNeeded(dev1,first.checksum),true,'resync while the portal has no state');
 check((await send(dev1,first)).body,{ok:true,baseline:true,added:0,removed:0},'the first report is the baseline and adds no new entry');
 check((await stored(dev1)).map(row=>[row.name,Number(row.baseline)]),[['ContosoAgent',1],['ContosoUpdater',1]],'baseline entries are not new');
 check((await autostartLib.consoleAutostart(JSON.stringify([dev1]))).get(dev1),{reportedAt:clock,count:2,newCount:0,suspiciousNewCount:0,newEntries:[]},'baseline without new entries');
 {const early=await send(dev1,first);check([early.status,early.body.code,early.body.messageKey],[429,'RATE_LIMITED','apiError.autostart.tooSoon'],'a second report within 60 s');}

 // ---- New, changed, removed, truncated ----
 later();
 const helper=await entry('Helper','C:\\Tools\\helper.exe',{signer:'Fabrikam'});
 const dropper=await entry('Dropper','C:\\Users\\…\\AppData\\Local\\Temp\\drop.exe',{scope:'user',location:'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',target:'C:\\Users\\…\\AppData\\Local\\Temp\\drop.exe',signature:'unsigned',signer:null,publisher:null,userPath:true});
 const agentChanged=await entry('ContosoAgent','"C:\\Program Files\\ContosoAgent\\ContosoAgent.exe" /background /verbose');
 check((await send(dev1,await report([agentChanged,updater,helper,dropper]))).body,{ok:true,baseline:false,added:3,removed:1},'unknown IDs are added, a missing ID is removed');
 const rows=await stored(dev1);
 check(rows.map(row=>[row.name,row.command.endsWith('/verbose')||!row.name.startsWith('ContosoA'),Number(row.baseline)]),[['ContosoAgent',true,0],['ContosoUpdater',true,1],['Dropper',true,0],['Helper',true,0]],'a changed command is a new entry; the old one is gone');
 check(rows.filter(row=>!Number(row.baseline)).every(row=>Number(row.firstSeen)===clock),true,'new entries have first_seen now');
 const summary=(await autostartLib.consoleAutostart(JSON.stringify([dev1,dev2]))).get(dev1);
 check([summary.count,summary.newCount,summary.suspiciousNewCount,summary.newEntries.map(item=>[item.name,item.suspicious])],[4,3,1,[['Dropper',true],['ContosoAgent',false],['Helper',false]]],'the console summary: new and suspicious new entries');
 later();
 check((await send(dev1,await report([agentChanged,helper,dropper],{count:2500,truncated:true}))).body,{ok:true,baseline:false,added:0,removed:0},'a truncated report deletes nothing');
 check((await stored(dev1)).length,4,'all entries stay');
 // Refusals.
 later();const valid=await report([agentChanged,updater,helper,dropper]);
 const mismatch=await send(dev1,{...valid,checksum:'0'.repeat(64)});
 check([mismatch.status,mismatch.body.code,mismatch.body.messageKey],[400,'AUTOSTART_REPORT_INVALID','apiError.autostart.reportInvalid'],'a checksum mismatch answers 400 AUTOSTART_REPORT_INVALID');
 check((await send(dev1,{...valid,items:[{...helper,id:'f'.repeat(64)}],checksum:await inventory.autostartChecksum([{...helper,id:'f'.repeat(64)}]),count:1})).status,400,'an entry ID that does not match its fields');
 check((await send(dev1,await report([await entry('Leak','C:\\Users\\alice\\leak.exe',{target:'C:\\Users\\alice\\leak.exe'})]))).status,400,'an unscrubbed user folder');
 check((await send(dev1,await report([await entry('Leak','C:/Users/alice/leak.exe')]))).status,400,'an unscrubbed user folder with forward slashes');
 check((await send(dev1,await report([await entry('Leak','C:\\Documents and Settings\\bob\\leak.exe')]))).status,400,'an unscrubbed Documents and Settings folder');
 check((await send(dev1,valid,{token:'token-'+dev2})).status,403,'another device token');
 check((await send(dev1,valid,{raw:JSON.stringify({serverId:dev1,...valid,padding:'x'.repeat(1048577)})})).status,413,'a body above 1 MiB');
 // Parallel first reports insert once.
 const parallel=await report([agent,helper]);
 const outcomes=await Promise.all([send(dev2,parallel),send(dev2,parallel),send(dev2,parallel)]);
 check(outcomes.filter(outcome=>outcome.status===200).length,1,'one parallel report wins');
 check((await stored(dev2)).length,2,'the entries are inserted once');

 // ---- Console summary in one statement ----
 counted.on=true;
 const both=await autostartLib.consoleAutostart(JSON.stringify([dev1,dev2,devB]));
 counted.on=false;
 check([both.size,both.get(dev2).newCount,counted.statements],[2,0,1],'one statement and one map for all reporting devices');
 check((await import('node:fs')).readFileSync('app/api/console/route.ts','utf8').match(/consoleAutostart\(/g).length,1,'the console route calls the summary once for all visible devices');

 // ---- Rules ----
 const base={hostname:'H',os:'Windows 11 Pro',cores:4,cpu:5,memory:30,disks:[],collectionErrors:[],processes:[],rebootPending:false};
 const issues=autostart=>evaluateAlertRules({lastSeen:time,snapshot:base,autostart},defaultAlertSettings(),time).filter(issue=>issue.ruleId.startsWith('autostart'));
 check(issues(summary).map(issue=>[issue.key,issue.level,issue.params]),[['autostart-suspicious','warning',{count:1,names:['Dropper']}],['autostart-new','info',{count:2,names:['ContosoAgent','Helper']}]],'info for new entries, warning for suspicious ones');
 check(issues({...summary,newCount:0,suspiciousNewCount:0,newEntries:[]}),[],'confirmed entries are silent');
 check(issues(undefined),[],'a device without a report: no issue');
 const evaluated={id:dev1,name:'DEV-1',createdAt:0,revoked:0,management:0,lastSeen:time,snapshot:base,autostart:summary};
 check(deviceIssues({...evaluated,issues:evaluateAlertRules(evaluated,defaultAlertSettings(),time)},time,'en').filter(item=>item.key.startsWith('autostart')).map(item=>[item.title,item.detail]),[['1 new suspicious autostart entry','Dropper. Confirm known entries in the Autostart area.'],['2 new autostart entries','ContosoAgent, Helper. Confirm known entries in the Autostart area.']],'issue texts (en)');
 check(deviceIssues({...evaluated,issues:evaluateAlertRules(evaluated,defaultAlertSettings(),time)},time,'de').filter(item=>item.key.startsWith('autostart')).map(item=>item.title),['1 neuer verdächtiger Autostart-Eintrag','2 neue Autostart-Einträge'],'issue titles (de)');

 // ---- Device view and confirmation ----
 const view=await deviceView(owner,dev1);
 check([view.status,view.body.items.length,view.body.canConfirm,view.body.reason],[200,4,true,null],'the device view for a manager');
 check(view.body.items.filter(item=>item.isNew).map(item=>[item.name,item.suspicious]),[['ContosoAgent',false],['Dropper',true],['Helper',false]],'new and suspicious flags');
 check([(await deviceView(reader,dev1)).body.canConfirm,(await deviceView(reader,dev1)).body.reason],[false,'right'],'Reader sees the list but cannot confirm');
 const helperId=view.body.items.find(item=>item.name==='Helper').id,dropperId=view.body.items.find(item=>item.name==='Dropper').id;
 const refused=await confirm(reader,{action:'confirm',id:dev1,entryIds:[helperId]});
 check(refused.status,403,'Reader is denied');
 check((await confirm(viewOnly,{action:'confirm',id:dev1,entryIds:[helperId]})).status,403,'view without manage: 403');
 check((await audits()).length,0,'no audit row on refusal');
 const accepted=await confirm(operator,{action:'confirm',id:dev1,entryIds:[helperId,helperId,'a'.repeat(64)]});
 check([accepted.status,accepted.body],[200,{ok:true,count:1}],'Operator confirms; duplicates and unknown IDs are skipped');
 let audit=await audits();
 check([audit.length,audit[0].actor,audit[0].serverId,audit[0].scope,JSON.parse(audit[0].target)],[1,'operator@as.test',dev1,'device',{entries:[{name:'Helper',category:'run',location:'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'}],count:1}],'one audit row with the entries');
 const confirmedRow=(await stored(dev1)).find(row=>row.name==='Helper');
 check([Number(confirmedRow.acknowledgedAt),confirmedRow.acknowledgedBy],[clock,'operator@as.test'],'the entry keeps time and actor');
 check((await deviceView(owner,dev1)).body.items.find(row=>row.name==='Helper').acknowledgedBy,'operator','the device view names the confirming user by display name');
 const nothing=await confirm(operator,{action:'confirm',id:dev1,entryIds:[helperId]});
 check([nothing.status,nothing.body.code,nothing.body.messageKey],[409,'AUTOSTART_NOTHING_TO_CONFIRM','apiError.autostart.nothingToConfirm'],'an already confirmed entry: 409');
 const stale=await confirm(owner,{action:'confirm-all',id:dev1,expected:'0'.repeat(64)});
 check([stale.status,stale.body.code,stale.body.messageKey],[409,'AUTOSTART_CHANGED','apiError.autostart.changed'],'confirm-all with an old checksum: 409');
 {const empty=await confirm(owner,{action:'confirm',id:dev1,entryIds:[]});check([empty.status,empty.body.code,empty.body.messageKey],[400,'INVALID_REQUEST','apiError.autostart.invalidSelection'],'an empty selection');}
 // A failing audit insert rolls the confirmation back.
 await createTrigger(d,'autostart_audit_fails','audit','BEFORE INSERT',{message:'audit-down'});
 const rolled=await confirm(owner,{action:'confirm',id:dev1,entryIds:[dropperId]});
 await dropTrigger(d,'autostart_audit_fails');
 check(rolled.status,500,'a failing audit insert fails the request');
 check((await stored(dev1)).find(row=>row.name==='Dropper').acknowledgedAt,null,'and confirms nothing');
 check((await audits()).length,1,'no second audit row');
 // Confirm all.
 const checksum=(await deviceView(owner,dev1)).body.state.checksum;
 const all=await confirm(owner,{action:'confirm-all',id:dev1,expected:checksum});
 check([all.status,all.body.count],[200,2],'confirm-all confirms the remaining new entries');
 audit=await audits();
 check([audit.length,JSON.parse(audit[1].target).count,JSON.parse(audit[1].target).entries.map(item=>item.name)],[2,2,['ContosoAgent','Dropper']],'one audit row for confirm-all');
 check((await autostartLib.consoleAutostart(JSON.stringify([dev1]))).get(dev1).newCount,0,'nothing is new after confirm-all');
 const again=await confirm(owner,{action:'confirm-all',id:dev1,expected:checksum});
 check([again.status,again.body.code],[409,'AUTOSTART_NOTHING_TO_CONFIRM'],'confirm-all with nothing new: 409');
 // A confirmation stays while the entry stays.
 later();check((await send(dev1,await report([agentChanged,updater,helper,dropper]))).body.added,0,'a later report with the same entries');
 check((await stored(dev1)).filter(row=>row.acknowledgedAt!==null).length,3,'confirmations are kept');

 // ---- Fleet aggregation ----
 later();await send(devB,await report([agent]));
 let fleetRows=(await fleet(owner,{scope:'all'})).body;
 check(fleetRows.rows.map(row=>row.deviceCount),[...fleetRows.rows.map(row=>row.deviceCount)].sort((a,b)=>a-b),'rare entries first (device count ascending)');
 check(fleetRows.rows.find(row=>row.name==='Helper').deviceCount,2,'grouped by category, name and target over devices');
 check((await fleet(owner,{scope:'all',q:'dropper'})).body.rows.map(row=>row.name),['Dropper'],'search by name');
 check((await fleet(owner,{scope:`customer:${customerB}`})).body.rows.flatMap(row=>row.deviceIds),[devB],'customer scope');
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 fleetRows=(await fleet(technician,{scope:'all'})).body;
 check(fleetRows.rows.some(row=>row.deviceIds.includes(devB)),false,'devices of an unseen customer never count');
 check((await fleet(technician,{scope:`customer:${customerB}`})).status,404,'an unseen customer answers 404');
 check((await deviceView(technician,devB)).status,404,'a device of an unseen customer answers 404');
 check((await confirm(technician,{action:'confirm-all',id:devB,expected:'0'.repeat(64)})).status,404,'confirming outside the boundary answers 404');

 // ---- Drift ----
 check(driftPolicySchema.safeParse({enabled:true,config:['services','autostart']}).success,true,'the drift policy accepts autostart');
 check(driftPolicySchema.safeParse({enabled:true,config:['autostart','autostart','autostart','autostart','autostart','autostart','autostart','autostart']}).success,false,'at most 7 config categories');

 // ---- Removing a device empties its autostart rows ----
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${dev1}`);
 check([(await stored(dev1)).length,(await d.query(sql`SELECT 1 FROM device_autostart_state WHERE server_id=${dev1}`)).length],[0,0],'the revoke trigger deletes list and state');
 console.log(`PASS autostart (${checks} checks): baseline, new and changed entries, removed and truncated reports, refusals, parallel reports, console summary, rules and texts, confirm and confirm-all with rights, boundary, 409 codes, audit and rollback, rare-first fleet view, drift category and the revoke trigger.`);
}finally{await d.close();}
