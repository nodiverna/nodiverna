// The Microsoft Defender jobs of agent 4.15.0 against PostgreSQL: POST
// /api/console {action:'job'} for the 4 kinds (only defender.control, the
// customer boundary, ReadOnly, MFA, an old agent, confirm, the Defender state
// checks, one job and one audit row, the job list only for viewers with
// defender.control) and {action:'defender-jobs'} for several devices (target
// limits, a named ineligible device writes nothing, the cross-customer gate,
// N jobs with N audit rows and one customer entry per customer, a right revoked
// between check and commit writes nothing). Real routes, lib/management.ts,
// lib/jobs/requirements.ts, lib/defender.ts, lib/server/devices/defender-jobs.ts and the
// real cross-customer gate (lib/server/identity/cross-customer.ts).
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';

let checks=0,viewer=null,mfaMissing=false,beforeTransaction=null;
const clock=Date.now();
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const uuid=()=>crypto.randomUUID(),noop=async()=>{},allow=sql`TRUE`;
const HttpError=realHttpError,d=await sourceDatabase();
const db=hookDatabase(d,{transaction:async()=>{const hook=beforeTransaction;beforeTransaction=null;if(hook)await hook();}});
const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});

const server={
 db:()=>db,now:()=>clock,config:()=>'',guid:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
 hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),HttpError,log:noop,
 requireViewer:async()=>viewer,sameOrigin:()=>{},body:request=>request.json(),random:()=>crypto.randomBytes(16).toString('hex'),
 // queueFullError comes from the loader's own copy of lib/errors/http-error.ts: keyed errors are matched by shape.
 failure:error=>error instanceof HttpError||typeof error?.status==='number'&&typeof error?.messageKey==='string'?Response.json({error:error.message,code:error.code,messageKey:error.messageKey},{status:error.status}):Response.json({error:String(error?.message??error)},{status:500}),
};
const imports={
 '../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./local-auth':{},
 '@/lib/server/identity/mfa':{requireMfa:async()=>{if(mfaMissing)throw new HttpError('apiError.mfa.loginRequired');}},
 '@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},
 '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
 '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>null,DISPATCH_LIFETIME_SECONDS:60,JOB_SIGNING_KEY_MISSING:'missing'},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},
 '@/lib/server/devices/device-group-catalog':{deviceGroupCatalog:async()=>[],devicePermissionTargets:async()=>[]},'@/lib/server/agent/device-tokens':{PERSONAL_REGISTRATION_LIFETIME:1},
 '@/lib/server/devices/device-lifecycle':{removeDevice:noop,removeDevices:noop,sweepRemovedTransfers:noop},'@/lib/server/devices/rdp':{sweepRdp:noop},
 '@/lib/server/audit-scope':{auditSelect:sql`SELECT 1`,deviceAuditGuard:()=>allow,portalAuditGuard:()=>allow},'@/lib/server/identity/customers':{visibleCustomers:async()=>[]},
 '@/lib/server/automation/runbooks':{tickAutomation:noop},'@/lib/server/automation/drift':{ingestDrift:noop},'@/lib/server/devices/file-access':{requireFileAccess:noop},
 '@/lib/server/devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'@/lib/server/devices/terminal-lifecycle':{sweepTerminalSessions:noop},
 '@/lib/server/devices/terminal-channel':{terminalReport:z.object({}),exchangeTerminals:async()=>[]},
};
const loader=sourceLoader(),load=file=>loader(file,imports);
const consoleApi=load('app/api/console/route.ts');
check(fs.readFileSync('app/api/console/route.ts','utf8').includes('INSERT INTO'),false,'the route has no SQL; lib/server/devices/defender-jobs.ts owns the bulk write');

// ---- Fixtures ----
const time=Date.now(),insert=(table,row)=>insertRow(d,table,row);
const customerA='00000000-0000-4000-8000-000000000100',customerB=uuid();
await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
async function persona(name,permissions){
 const id=uuid(),principal='local:'+id,roleId=uuid();
 await insert('local_users',{id,username:name,email:name+'@defender.test',display_name:name,auth_principal:principal,auth_email:name+'@defender.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 await insert('rbac_roles',{id:roleId,name:'Role '+name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${id},${roleId},'global','*',${time},'fixture')`);
 return stamped({id,userId:id,label:name+'@defender.test',principal,username:name,displayName:name,permissions:permissions.includes('*')?['*']:[],roleId});
}
const kinds=['defender-quick-scan','defender-full-scan','defender-update-signatures','defender-clean-detections'];
const at=new Date(time).toISOString();
const report=(extra={})=>({available:true,collectedAt:at,mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,quickScanAt:at,fullScanAt:null,signatureAt:at,signatureVersion:'1.421.1868.0',productVersion:'4.18.24090.11',otherAntivirus:null,detectionCount:1,activeCount:1,highestActiveSeverity:'severe',truncated:false,detections:[],exclusions:null,...extra});
const snapshot=({mode='Management',agentCapabilities=['defender-status',...kinds],defender=report(),defenderScan}={})=>JSON.stringify({protocolVersion:3,mode,management:mode==='Management',agentCapabilities,os:'Microsoft Windows Server 2025 Standard',...(defender?{defender}:{}),...(defenderScan?{defenderScan}:{})});
async function device(name,{customer=customerA,management=1,lastSeen=clock,...shape}={}){
 const id=uuid();
 await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:lastSeen,management,snapshot:snapshot(shape),customer_id:customer,revoked:0});
 return id;
}
const operator=await persona('operator',['view','defender.control']),manager=await persona('manager',['view','manage','defender.read']),owner=await persona('owner',['*']);
const crossTech=await persona('crosstech',['view','defender.control']),crossRight=await persona('crossright',['view','defender.control','portal.msp.crossCustomer']);
const ready=await device('DEF-READY'),clean=await device('DEF-CLEAN',{defender:report({activeCount:0,detectionCount:0,highestActiveSeverity:null})});
const scanning=await device('DEF-SCAN',{defenderScan:{kind:'full',startedAt:at}}),stopped=await device('DEF-STOPPED',{defender:report({mode:'not-running'})});
const missing=await device('DEF-MISSING',{defender:{available:false,reason:'not-installed',collectedAt:at}});
const readOnly=await device('DEF-RO',{management:0,mode:'ReadOnly'}),oldAgent=await device('DEF-OLD',{agentCapabilities:['defender-status']});
const offline=await device('DEF-OFFLINE',{lastSeen:clock-10*60000}),foreign=await device('DEF-FOREIGN',{customer:customerB});
// The boundary: the operator sees customer A only; the cross-customer personas see both.
for(const [person,customers] of [[operator,[customerA]],[manager,[customerA]],[crossTech,[customerA,customerB]],[crossRight,[customerA,customerB]]])
 for(const customer of customers)await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customer},'user',${person.id},${time},'fixture')`);

const post=async(v,body)=>{viewer=v;const response=await consoleApi.POST(new Request('https://defender.test/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
const job=(v,id,kind='defender-quick-scan',extra={})=>post(v,{action:'job',id,kind,params:{},confirm:true,...extra});
const jobs=async ids=>(await d.query(sql`SELECT server_id,action,target,parameters,actor FROM jobs WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY created_at,id`));
const deviceAudit=async ids=>(await d.query(sql`SELECT server_id,actor,action,target FROM audit WHERE scope='device' AND server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY id`));
const customerRows=async()=>(await d.query(sql`SELECT customer_id,action,target FROM audit WHERE scope='portal' AND action='Defender-Aktion kundenübergreifend gestartet' ORDER BY customer_id`));
const all=[ready,clean,scanning,stopped,missing,readOnly,oldAgent,offline,foreign];
const counts=async()=>[(await jobs(all)).length,(await deviceAudit(all)).length,(await customerRows()).length];

// ---- One device ----
{
 const refuse=async(v,id,kind,expected,label,extra)=>{const answer=await job(v,id,kind,extra);check([answer.status,answer.body.messageKey],expected,label);};
 await refuse(manager,ready,'defender-quick-scan',[403,'apiError.access.devicePermissionMissing'],'manage without defender.control is refused');
 await refuse(owner,ready,'defender-quick-scan',[200,undefined],'the Owner may');
 await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`DELETE FROM audit`);
 await refuse(operator,foreign,'defender-quick-scan',[404,'apiError.device.notFound'],'a device of another customer answers 404');
 await refuse(operator,readOnly,'defender-update-signatures',[403,'apiError.agent.readOnlyEnableManagement'],'ReadOnly');
 mfaMissing=true;const noMfa=await job(operator,ready);mfaMissing=false;
 check([noMfa.status,noMfa.body.code],[403,'MFA_LOGIN_REQUIRED'],'no fresh MFA session gives the MFA code');
 await refuse(operator,oldAgent,'defender-quick-scan',[409,'apiError.agent.functionUnavailable'],'agent 4.14.0 without the capability');
 await refuse(operator,ready,'defender-quick-scan',[400,'apiError.console.confirmServerChange'],'a missing confirm is refused',{confirm:undefined});
 await refuse(operator,ready,'defender-quick-scan',[400,'apiError.console.invalidParameters'],'parameters are refused',{params:{path:'C:\\'}});
 await refuse(operator,clean,'defender-clean-detections',[409,'apiError.defender.noActiveDetections'],'clean without active detections');
 await refuse(operator,scanning,'defender-quick-scan',[409,'apiError.defender.scanRunning'],'a quick scan while a portal scan runs');
 await refuse(operator,scanning,'defender-full-scan',[409,'apiError.defender.scanRunning'],'a full scan while a portal scan runs');
 await refuse(operator,stopped,'defender-update-signatures',[409,'apiError.defender.unavailable'],'Defender not running');
 await refuse(operator,missing,'defender-quick-scan',[409,'apiError.defender.unavailable'],'Defender not installed');
 check(await counts(),[0,0,0],'no refusal writes a job or an audit row');
 await refuse(operator,scanning,'defender-update-signatures',[200,undefined],'a signature update while a scan runs is allowed');
 const okAnswer=await job(operator,ready,'defender-clean-detections');
 check([okAnswer.status,typeof okAnswer.body.id],[200,'string'],'a queued job answers its ID');
 check((await jobs([ready])).map(row=>[row.action,row.target,row.parameters,row.actor]),[['defender-clean-detections','','{}',operator.id]],'one job without a target or parameters');
 check((await deviceAudit([ready])).map(row=>[row.actor,row.action,row.target]),[[operator.label,'Alle aktiven Defender-Funde bereinigen','DEF-READY']],'one device audit row: actor, German label, device name');
 // The console job list shows Defender jobs only to viewers with defender.control on the device.
 const listed=async v=>{viewer=v;const response=await consoleApi.GET(new Request('https://defender.test/api/console?jobsOnly=1'));return (await response.json()).jobs.filter(item=>item.action==='defender-clean-detections').length;};
 check([await listed(operator),await listed(manager),await listed(owner)],[1,0,1],'the job is listed for defender.control and the Owner, not for manage');
 await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`DELETE FROM audit`);
}

// ---- Several devices ----
{
 const bulk=(v,ids,kind='defender-quick-scan',extra={})=>post(v,{action:'defender-jobs',kind,ids,confirm:true,...extra});
 for(const [label,ids] of [['no device',[]],['101 devices',Array.from({length:101},uuid)],['a duplicate',[ready,ready]],['an invalid ID',['not-a-guid']]]){
  const answer=await bulk(operator,ids);check([answer.status,answer.body.messageKey],[400,'apiError.defender.targets'],`${label} is refused`);
 }
 check((await bulk(operator,[ready],'refresh')).body.messageKey,'apiError.request.invalidAction','only the 4 Defender kinds');
 check((await bulk(operator,[ready],'defender-quick-scan',{confirm:false})).body.messageKey,'apiError.console.confirmServerChange','confirm must be true');
 mfaMissing=true;check((await bulk(operator,[ready])).body.code,'MFA_LOGIN_REQUIRED','MFA once before any write');mfaMissing=false;
 check((await bulk(manager,[ready])).body.messageKey,'apiError.access.devicePermissionMissing','every device needs defender.control');
 check((await bulk(operator,[ready,foreign])).status,404,'a device outside the boundary answers 404');
 const named=async(ids,kind,key,name,label)=>{const answer=await bulk(operator,ids,kind);check([answer.status,answer.body.messageKey,answer.body.error.includes(name)],[answer.status,key,true],label);};
 await named([ready,offline],'defender-quick-scan','apiError.defender.deviceOffline','DEF-OFFLINE','an offline device is named');
 await named([ready,readOnly],'defender-quick-scan','apiError.defender.deviceReadOnly','DEF-RO','a ReadOnly device is named');
 await named([ready,oldAgent],'defender-quick-scan','apiError.defender.deviceAgent','DEF-OLD','an old agent is named');
 await named([ready,stopped],'defender-update-signatures','apiError.defender.deviceUnavailable','DEF-STOPPED','Defender not running is named');
 await named([ready,scanning],'defender-full-scan','apiError.defender.deviceScanRunning','DEF-SCAN','a running scan is named');
 await named([ready,clean],'defender-clean-detections','apiError.defender.deviceNoDetections','DEF-CLEAN','no detections is named');
 check(await counts(),[0,0,0],'one ineligible device writes nothing');

 // A device at the queue limit.
 for(let index=0;index<20;index++)await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,created_at,actor,actor_email,actor_principal) VALUES (${uuid()},${clean},'refresh','','{}',${time},'fixture','fixture','private:fixture')`);
 const full=await bulk(operator,[ready,clean],'defender-update-signatures');
 check([full.status,full.body.messageKey],[429,'apiError.console.queueFull'],'a device at MAX_QUEUED_JOBS gives queueFull');
 await d.exec(sql`DELETE FROM jobs`);

 // Two customers.
 const pair=[ready,foreign];
 const forbidden=await bulk(crossTech,pair);
 check([forbidden.status,forbidden.body.code],[403,'CROSS_CUSTOMER_FORBIDDEN'],'2 customers without portal.msp.crossCustomer');
 check(await counts(),[0,0,0],'the refused cross-customer request writes nothing');
 const accepted=await bulk(owner,[ready,scanning,foreign],'defender-update-signatures');
 check([accepted.status,accepted.body.jobs?.length],[200,3],'the Owner gets one job per device');
 check((await jobs([ready,scanning,foreign])).map(row=>[row.action,row.target,row.parameters]).sort(),Array(3).fill(['defender-update-signatures','','{}']),'N jobs');
 check((await deviceAudit([ready,scanning,foreign])).map(row=>[row.actor,row.action,row.target]).sort(),[[owner.label,'Defender-Signaturen aktualisieren','DEF-FOREIGN'],[owner.label,'Defender-Signaturen aktualisieren','DEF-READY'],[owner.label,'Defender-Signaturen aktualisieren','DEF-SCAN']],'N device audit rows');
 check((await customerRows()).map(row=>[row.customer_id,row.target]).sort(),[[customerA,'Defender-Signaturen aktualisieren · 2 von 3 Geräten'],[customerB,'Defender-Signaturen aktualisieren · 1 von 3 Geräten']].sort(),'one customer entry per customer');
 check(new Set(accepted.body.jobs).size===3&&(await jobs([ready,scanning,foreign])).length===3,true,'the answer names the written jobs');
 await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`DELETE FROM audit`);

 // One customer: no gate and no customer entry.
 const single=await bulk(crossTech,[ready,scanning],'defender-update-signatures');
 check([single.status,(await jobs([ready,scanning])).length,(await customerRows()).length],[200,2,0],'one customer needs no cross-customer right');
 const withRight=await bulk(crossRight,[ready,foreign],'defender-clean-detections');
 check([withRight.status,(await customerRows()).length],[200,2],'with the right two customers are allowed');
 await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`DELETE FROM audit`);

 // The right is revoked between the checks and the commit: nothing is written.
 beforeTransaction=()=>d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(['view'])} WHERE id=${operator.roleId}`);
 const raced=await bulk(operator,[ready,scanning],'defender-update-signatures');
 check([raced.status,raced.body.messageKey],[409,'apiError.console.queueChanged'],'a guard that turns false before the commit gives queueChanged');
 check(await counts(),[0,0,0],'and writes no job, no audit row and no customer entry');
 await d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(['view','defender.control'])} WHERE id=${operator.roleId}`);
 // All or nothing: the queue of the second device fills up between the checks and the commit.
 beforeTransaction=async()=>{for(let index=0;index<20;index++)await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,created_at,actor,actor_email,actor_principal) VALUES (${uuid()},${scanning},'refresh','','{}',${time},'fixture','fixture','private:fixture')`);};
 const partial=await bulk(operator,[ready,scanning],'defender-update-signatures');
 check([partial.status,partial.body.messageKey,(await jobs([ready])).length,(await deviceAudit(all)).length],[409,'apiError.console.queueChanged',0,0],'one refused insert rolls back the jobs before it: no partial set');
}
await d.close?.();
console.log(`PASS defender jobs (${checks} checks): one device needs only defender.control, the boundary, Management mode, MFA, the capability, confirm and the Defender state, and writes one job and one audit row listed only for defender.control; several devices check every device and name the first ineligible one, the cross-customer gate, N jobs with N audit rows and one customer entry per customer, and a revoked right or a full queue before the commit writes nothing.`);
