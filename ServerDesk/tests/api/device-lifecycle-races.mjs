// Execute actual source SQL against an isolated PostgreSQL test database with deliberate stale reads.
import {pureModule} from '../support/pure-modules.mjs';
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import {sourceDatabase,inTransaction,dbModule} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {runtimePath} from '../support/runtime-path.mjs';
import * as crossCustomerRight from '../../lib/cross-customer-right.ts';
import {sql} from '../../runtime/database.mjs';
const require=createRequire(import.meta.url);
const d=await sourceDatabase();
try{
 const r2={delete:async()=>{}};
 const owner={id:crypto.randomUUID(),label:'owner@races.test',permissions:['*']},admin={id:crypto.randomUUID(),label:'admin@races.test',permissions:['*']};
 for(const actor of [owner,admin])Object.defineProperty(actor,'authorization',{value:{authVersion:1},enumerable:false});
 const HttpError=realHttpError;
 const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),guid=x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x);
 const currentDb=d;let accessHook=async()=>{};
 const server={db:()=>currentDb,config:()=>'',guid,now:()=>Date.now(),hash:async x=>sha(x),body:request=>request.json(),failure:error=>Response.json({error:error.message},{status:error.status??503}),HttpError};
 const load=(path,imports={})=>{const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,exports={},fixture={exports};new Function('require','exports','module',code)(name=>name in imports?imports[name]:pureModule(name)??(name==='./db'||name==='../db'||name==='../../db'?dbModule():require(runtimePath(name))),exports,fixture);return fixture.exports;};
 const access=load('lib/server/identity/access.ts',{'../context':server,'../../cross-customer-right':crossCustomerRight}),features=load('lib/server/identity/feature-authorization.ts',{'./access':access});
 // The real Owner policy (lib/server/identity/policy/can.ts). The wrapper runs policyHook right
 // after the pre-check, so a demotion can land between pre-check and commit.
 let policyHook=async()=>{};
 const policy=load('lib/server/identity/policy/can.ts',{'../../context':server,'../access':access,'../feature-authorization':features});
 const checkedPolicy={...policy,can:async(...args)=>{const answer=await policy.can(...args);await policyHook();return answer;},requireCan:async(...args)=>{await policy.requireCan(...args);await policyHook();}};
 const deviceTokens=load('lib/server/agent/device-tokens.ts',{'../context':server});
 const v3=load('lib/server/agent/agent-protocol.ts',{'cloudflare:workers':{env:{BUCKET:r2}},'../context':server,'./device-tokens':deviceTokens});
 const fileAccess=load('lib/server/devices/file-access.ts',{'../identity/access':access,'../../file-operations':load('lib/file-operations.ts')}),transfers=load('lib/server/devices/transfers.ts',{'../context':server,'../agent/agent-protocol':v3,'../identity/feature-authorization':features,'../identity/access':access,'./file-access':fileAccess});
 const jobExpiryModule=load('lib/job-expiry.ts'),lifecycle=load('lib/server/devices/device-lifecycle.ts',{'../identity/feature-authorization':features,'./jobs/queue':load('lib/server/devices/jobs/queue.ts'),'../../job-expiry':jobExpiryModule,'../../agent-messages':{parseAgentArgs:()=>null},'../../offboarding':load('lib/offboarding.ts',{'./job-expiry':jobExpiryModule}),'./offboarding':load('lib/offboarding.ts',{'./job-expiry':jobExpiryModule}),'../context':server,'../audit':load('lib/server/audit.ts',{'./context':server}),'../identity/policy/can':checkedPolicy,'./transfers':transfers,'../identity/access':{...access,requireDevice:async(...args)=>{const device=await access.requireDevice(...args);await accessHook();return device;}}});
 const at=Date.now(),token='a'.repeat(64),id=crypto.randomUUID();
 const ownerRole=crypto.randomUUID(),adminRole=crypto.randomUUID();
 await inTransaction(d,[
  ...[owner,admin].map(actor=>sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${actor.id},${actor.label},${actor.label},${actor.label},${access.principal(actor)},${actor.label},'active',1,${at},${at})`),
  ...[[ownerRole,'Owner'],[adminRole,'Admin']].map(([role,name])=>sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${role},${name},'','["*"]',0,${at})`),
  ...[[owner,ownerRole],[admin,adminRole]].map(([actor,role])=>sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},'user',${actor.id},${role},'global','*',${at},'fixture')`)
 ]);
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,token_expires_at) VALUES (${id},${'Stale admin test'},${sha(token)},${at},${at+7*86400000})`);
 // Removal needs a fresh step-up proof (lib/step-up.ts). The fixture proof has
 // the shape of prepareManagementAuthorization: a live row, consumed by the batch.
 const proof=async actor=>{const tokenHash=sha(crypto.randomUUID()),sessionHash=sha(actor.id+'mfa');await d.exec(sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${tokenHash},${access.principal(actor)},${sessionHash},${Date.now()+300_000})`);const key=access.principal(actor);return {tokenHash,key,sessionHash,guard:sql`EXISTS (SELECT 1 FROM mfa_management_proofs WHERE token_hash=${tokenHash} AND principal=${key} AND session_hash=${sessionHash} AND expires_at>${Date.now()})`};};
 const proofs=async()=>(await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs`)).n;
 accessHook=()=>d.exec(sql`UPDATE rbac_roles SET permissions=${'["view"]'} WHERE id=${adminRole}`);
 const demoted=await proof(admin);
 await assert.rejects(()=>lifecycle.removeDevice(admin,id,true,demoted),e=>e.status===403&&e.code==='ACCESS_NOT_APPROVED');
 assert.equal((await d.one(sql`SELECT revoked FROM servers WHERE id=${id}`)).revoked,0,'captured admin actor cannot revoke after role demotion');
 assert.equal((await d.one(sql`SELECT count(*) AS n FROM audit`)).n,0,'stale admin cannot partially clean or audit');
 assert.equal(await proofs(),1,'a refused removal keeps its proof');
 accessHook=async()=>{};
 await d.exec(sql`UPDATE rbac_roles SET permissions=${'["*"]'} WHERE id=${adminRole}`);
 // Each request builds its own viewer; can() answers once per viewer object.
 const request=()=>{const viewer={...admin};Object.defineProperty(viewer,'authorization',{value:{authVersion:1},enumerable:false});return viewer;};
 const unchanged=async label=>{assert.equal((await d.one(sql`SELECT revoked FROM servers WHERE id=${id}`)).revoked,0,label);assert.equal((await d.one(sql`SELECT count(*) AS n FROM audit`)).n,0,label+': no audit row');};
 // The Owner check is live, not a snapshot. A viewer built as
 // Owner (role 'admin') whose Owner right is gone before the request is refused
 // by the pre-check.
 await d.exec(sql`UPDATE rbac_roles SET permissions=${'["view"]'} WHERE id=${adminRole}`);
 const refused=await proof(admin);await assert.rejects(()=>lifecycle.removeDevice(request(),id,true,refused),e=>e.status===403&&e.message===serverText('apiError.devices.removeAdminOnly'));
 await unchanged('a demoted snapshot Owner is refused before any work');
 await d.exec(sql`UPDATE rbac_roles SET permissions=${'["*"]'} WHERE id=${adminRole}`);
 // The pre-check passes, then the Owner assignment is deleted before the
 // commit. The actor keeps manage on the device, so only the Owner guard in the
 // committing batch refuses.
 const managerRole=crypto.randomUUID(),managerAssignment=crypto.randomUUID();
 await d.exec(sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${managerRole},'Manager','','["view","manage"]',0,${at})`);
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${managerAssignment},'user',${admin.id},${managerRole},'global','*',${at},'fixture')`);
 policyHook=()=>d.exec(sql`DELETE FROM role_assignments WHERE principal_id=${admin.id} AND role_id=${adminRole}`);
 const racing=await proof(admin);await assert.rejects(()=>lifecycle.removeDevice(request(),id,true,racing),e=>e.status===403&&e.code==='ACCESS_NOT_APPROVED'&&e.message===serverText('apiError.devices.removeApprovalChanged'));
 policyHook=async()=>{};
 await unchanged('an Owner demoted after the pre-check cannot revoke');
 await inTransaction(d,[sql`DELETE FROM role_assignments WHERE id=${managerAssignment}`,sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},'user',${admin.id},${adminRole},'global','*',${at},'fixture')`]);
 // A used proof and a proof that disappears right before the batch remove nothing.
 const used=await proof(admin);await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${used.tokenHash}`);
 await assert.rejects(()=>lifecycle.removeDevices(admin,[id],true,used),e=>e.status===403&&e.code==='MFA_STEP_UP_REQUIRED');
 const vanishing=await proof(admin);accessHook=()=>d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${vanishing.tokenHash}`);
 await assert.rejects(()=>lifecycle.removeDevice(admin,id,true,vanishing),e=>e.status===403&&e.code==='MFA_STEP_UP_REQUIRED');accessHook=async()=>{};
 assert.equal((await d.one(sql`SELECT revoked FROM servers WHERE id=${id}`)).revoked,0,'no removal without a live proof');
 assert.equal((await d.one(sql`SELECT count(*) AS n FROM audit`)).n,0,'no audit row without a live proof');
 await d.exec(sql`DELETE FROM mfa_management_proofs`);
 const hardwareInventory=load('lib/server/devices/hardware-inventory.ts'),telemetry=load('lib/server/agent/telemetry.ts',{'../devices/hardware-inventory':hardwareInventory}),jobExpiry=load('lib/job-expiry.ts'),heartbeat=load('app/api/heartbeat/route.ts',{'@/lib/server/context':server,'@/lib/server/agent/telemetry':telemetry,'@/lib/server/agent/device-tokens':deviceTokens,'@/lib/server/agent/heartbeat':load('lib/server/agent/heartbeat.ts',{'./device-tokens':deviceTokens,'../../job-expiry':jobExpiry,'../../device-name':load('lib/device-name.ts'),'../../jobs/requirements':await import('../../lib/jobs/requirements.ts'),'../../plugin-catalog':await import('../../lib/plugin-catalog.ts'),'../extensions/plugin-results':await import('../../lib/server/extensions/plugin-results.ts')}),'@/lib/server/devices/software':{softwareResyncNeeded:async()=>false},'@/lib/server/devices/drivers':{driverResyncNeeded:async()=>false},'@/lib/server/devices/autostart':{autostartResyncNeeded:async()=>false},
  // The alarm state after a heartbeat has its own test (tests/api/alerts.mjs).
  '@/lib/server/devices/alerts':{syncDeviceAlerts:async()=>{}}});
 const jwk=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});
 const snapshot={hostname:'VM',os:'Microsoft Windows Server 2025 Standard',build:'26100',manufacturer:'Microsoft',model:'VM',domain:'WORKGROUP',cores:4,memoryGb:8,cpu:10,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'3.1.1',mode:'Management',publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},agentCapabilities:['refresh']};
 // Offboarding lands after the heartbeat's identity read, before its write transaction.
 const hooked=hookDatabase(d);hooked.beforeNextTransaction(async()=>{await lifecycle.removeDevice(owner,id,true,await proof(owner));});
 const response=await heartbeat.POST(new Request('https://serverdesk.test/api/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({serverId:id,snapshot,results:[]})}));
 assert.equal(response.status,403,'old heartbeat rejected if offboarding happens after its identity read');
 assert.deepEqual(await d.one(sql`SELECT revoked,snapshot,last_seen,management,agent_public_key FROM servers WHERE id=${id}`),{revoked:1,snapshot:null,last_seen:null,management:0,agent_public_key:null});
 assert.equal((await d.one(sql`SELECT count(*) AS n FROM samples WHERE server_id=${id}`)).n,0,'in-flight telemetry cannot repopulate purged samples');
 assert.equal((await d.one(sql`SELECT count(*) AS n FROM audit`)).n,1,'only the explicit offboarding audit remains');
 assert.equal(await proofs(),0,'the removal consumed its proof');
 await assert.rejects(()=>v3.lease(id,'terminal',crypto.randomUUID(),at+60000),e=>e.status===409);
 assert.equal((await d.one(sql`SELECT count(*) AS n FROM device_leases`)).n,0,'delayed lease acquisition cannot recreate device maintenance');
 console.log('PASS lifecycle races: captured admin role demotion, atomic no partial cleanup/audit, heartbeat revoked after trusted lookup cannot repopulate telemetry, and revoked lease admission.');
}finally{d.close();}
