// The audit reads of the audit log page against PostgreSQL, through the real console route and lib/server/audit-scope.ts:
// a portal entry whose target is an internal account value gets the account's shown name as targetName (one query),
// a device entry never does; "Load older entries" (GET ?audit=portal&before=<at>.<id>) answers the next rows in
// order without overlap under portalAuditGuard, nothing for a viewer without the portal audit right, and 400 for a
// malformed cursor.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

let checks=0,viewer=null;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const uuid=()=>crypto.randomUUID(),noop=async()=>{},allow=sql`TRUE`,clock=Date.now();
const HttpError=realHttpError,d=await sourceDatabase();
const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
const server={
 db:()=>d,now:()=>clock,config:()=>'',guid:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
 hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),HttpError,log:noop,
 requireViewer:async()=>viewer,sameOrigin:()=>{},body:request=>request.json(),random:()=>crypto.randomBytes(16).toString('hex'),
 failure:error=>error instanceof HttpError||typeof error?.status==='number'&&typeof error?.messageKey==='string'?Response.json({error:error.message,code:error.code,messageKey:error.messageKey},{status:error.status}):Response.json({error:String(error?.message??error)},{status:500}),
};
const imports={
 '../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./local-auth':{},
 '@/lib/server/identity/mfa':{requireMfa:noop},'@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},
 '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
 '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>null,DISPATCH_LIFETIME_SECONDS:60,JOB_SIGNING_KEY_MISSING:'missing'},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},
 '@/lib/server/devices/device-group-catalog':{deviceGroupCatalog:async()=>[],devicePermissionTargets:async()=>[]},'@/lib/server/agent/device-tokens':{PERSONAL_REGISTRATION_LIFETIME:1},
 '@/lib/server/devices/device-lifecycle':{removeDevice:noop,removeDevices:noop,sweepRemovedTransfers:noop},'@/lib/server/devices/rdp':{sweepRdp:noop},
 '@/lib/server/identity/customers':{visibleCustomers:async()=>[]},'@/lib/server/agent/portal-certificate':{portalCertificateView:()=>null,portalRootCertificate:()=>null},
 '@/lib/server/identity/security-alarms':{consoleEmergencyAlarms:async()=>({open:0,latest:null})},
 '@/lib/server/automation/runbooks':{tickAutomation:noop},'@/lib/server/automation/drift':{ingestDrift:noop},'@/lib/server/devices/file-access':{requireFileAccess:noop},
 '@/lib/server/devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'@/lib/server/devices/terminal-lifecycle':{sweepTerminalSessions:noop},
 '@/lib/server/devices/terminal-channel':{terminalReport:z.object({}),exchangeTerminals:async()=>[]},
};
const loader=sourceLoader(),load=file=>loader(file,imports);
const consoleApi=load('app/api/console/route.ts');

const time=Date.now(),insert=(table,row)=>insertRow(d,table,row);
async function persona(name,permissions){
 const id=uuid(),principal='local:'+id,roleId=uuid();
 await insert('local_users',{id,username:name,email:name+'@audit.test',display_name:name,auth_principal:principal,auth_email:name+'@audit.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 await insert('rbac_roles',{id:roleId,name:'Role '+name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${id},${roleId},'global','*',${time},'fixture')`);
 return stamped({id,userId:id,label:name+'@audit.test',principal,username:name,displayName:name,permissions:permissions.includes('*')?['*']:[]});
}
const owner=await persona('owner',['*']),admin=await persona('admin',['view','manage','security.events','portal.users.manage']);
// An account stored under its internal auth email, with a display name.
const annaId=uuid(),annaEmail=`${annaId}@local.serverdesk.invalid`;
await insert('local_users',{id:annaId,username:'anna',email:'anna@contoso.test',display_name:'Anna Admin',auth_principal:'local:'+annaEmail,auth_email:annaEmail,status:'active',auth_version:1,created_at:time,updated_at:time});
const ghost=`${uuid()}@local.serverdesk.invalid`;
const deviceId=uuid();
await insert('servers',{id:deviceId,name:'AUDIT-01',token_hash:'fixture-'+deviceId,created_at:time,last_seen:time,management:1,snapshot:null,revoked:0});
await d.exec(sql`DELETE FROM audit`);
// 105 portal rows, the newest with the account targets, one device row with an internal target.
for(let index=0;index<105;index++)await d.exec(sql`INSERT INTO audit (at,actor,action,target,scope) VALUES (${time-index*1000},'owner@audit.test','auth.user.update',${index===0?annaEmail:index===1?ghost:'plain-'+index},'portal')`);
await d.exec(sql`INSERT INTO audit (at,actor,action,target,server_id,scope) VALUES (${time},'owner@audit.test','tag.set',${annaEmail},${deviceId},'device')`);
const get=async(v,query='')=>{viewer=v;const response=await consoleApi.GET(new Request('https://audit.test/api/console'+query));return {status:response.status,body:await response.json()};};

// ---- targetName ----
const load100=await get(owner);
check(load100.status,200,'the console load answers');
check(load100.body.audit.length,100,'the newest 100 portal rows');
check([load100.body.audit[0].targetName,load100.body.audit[1].targetName],['Anna Admin',null],'an internal account target gets its name, or null without one');
check(load100.body.audit.slice(2).some(entry=>'targetName' in entry),false,'other targets get no targetName');
const deviceRows=load100.body.deviceAudit.filter(entry=>entry.serverId===deviceId);
check([deviceRows.length,deviceRows.some(entry=>'targetName' in entry)],[1,false],'a device entry gets no targetName');

// ---- Load older entries ----
const oldest=load100.body.audit.at(-1);
const older=await get(owner,`?audit=portal&before=${oldest.at}.${oldest.id}`);
check(older.status,200,'the older read answers');
check(older.body.audit.map(entry=>entry.target),['plain-100','plain-101','plain-102','plain-103','plain-104'],'the next rows in order, no overlap');
const shown=new Set(load100.body.audit.map(entry=>entry.id));
check(older.body.audit.some(entry=>shown.has(entry.id)),false,'no row twice');
check((await get(owner,`?audit=portal&before=${time-1000}.${load100.body.audit[1].id}`)).body.audit[0].target,'plain-2','the cursor compares (at, id)');
check((await get(admin,`?audit=portal&before=${oldest.at}.${oldest.id}`)).body.audit,[],'a viewer without the portal audit right gets nothing');
for(const before of ['x','1.','1.2.3','-1.2',`${oldest.at}`,'99999999999999999.1']){
 const bad=await get(owner,`?audit=portal&before=${before}`);
 check([bad.status,bad.body.messageKey],[400,'apiError.request.invalidAction'],`a malformed cursor "${before}" answers 400`);
}
check((await get(owner,'?audit=device&before=1.1')).status,400,'only the portal audit pages');

await d.close();
console.log(`PASS audit log api (${checks} checks): targetName for internal account targets of portal rows only, and "Load older entries" in order without overlap, under portalAuditGuard, with 400 for a malformed cursor.`);
