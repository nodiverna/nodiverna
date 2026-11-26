// Moving devices to another customer through the real route app/api/console/route.ts (action move-customer,
// lib/server/devices/device-customer-move.ts, docs/customers.md "Move devices to another customer"): the input check
// before MFA and the proof, the step-up answer, every refusal without a write, the rights on the devices and on the
// target (group or "Ungrouped"), the cross-customer gate, the single live admission with races between the pre-check
// and the commit, what ends and what stays in the same batch, the visibility for the technicians of both customers,
// the pins, and the two audit rows per device. Against an isolated PostgreSQL test database; only the request
// environment (session, MFA proof reader) and the object storage of the transfers are replaced.
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {HttpError} from '../support/http-error.mjs';
const {apiErrorBody,classifyFailure}=await import('../../lib/server/errors/failure.ts');

const day=86_400_000,customerA='00000000-0000-4000-8000-000000000100';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const uuid=()=>crypto.randomUUID();
const action='device.customer.move',reason='serverMessage.device.movedCustomer';
const rights=['view','manage','groups.manage'];
// Each refusal as [status, code, message key] (lib/errors/api-error-keys.ts).
const refused={
 selectRange:[400,'INVALID_REQUEST','apiError.devices.selectRange'],
 confirm:[400,'INVALID_REQUEST','apiError.devices.moveConfirm'],
 customerInvalid:[400,'INVALID_REQUEST','apiError.customer.invalid'],
 groupInvalid:[400,'INVALID_REQUEST','apiError.devices.moveGroupInvalid'],
 stepUp:[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.stepUpRequired'],
 proofExpired:[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.proofExpired'],
 notFound:[404,'NOT_FOUND','apiError.devices.moveNotFound'],
 unavailable:[404,'CUSTOMER_MISSING','apiError.customer.unavailable'],
 disabled:[409,'CUSTOMER_DISABLED','apiError.customer.disabled'],
 groupNotFound:[404,'NOT_FOUND','apiError.group.notFound'],
 sameCustomer:[400,'INVALID_REQUEST','apiError.devices.moveSameCustomer'],
 forbidden:[403,'FORBIDDEN','apiError.devices.moveForbidden'],
 crossRight:[403,'CROSS_CUSTOMER_FORBIDDEN','apiError.crossCustomer.right'],
 changed:[409,'CONFLICT','apiError.devices.moveChanged'],
};
const keyed=sent=>[sent.status,sent.body.code,sent.body.messageKey];

async function fixture(run){
 const d=await sourceDatabase(),time=()=>Date.now(),swept=[],record=[];
 let viewer=null,hook=null;
 // The hook runs once, right before the n-th transaction: the move's batch is the first one of a request.
 const facade=hookDatabase(d,{record,transaction:async()=>{if(hook&&--hook.n===0){const change=hook.action;hook=null;await change();}}});
 const server={db:()=>facade,now:time,config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),HttpError,
  body:request=>request.json(),sameOrigin:()=>{},guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),
  requireViewer:async()=>{if(!viewer)throw new HttpError('apiError.auth.loginRequired');return viewer;},log:async()=>{},
  // As lib/server/context.ts failure(): an HttpError answers with its status, code, message key and params.
  failure:error=>{const answer=error instanceof HttpError?classifyFailure(error):{status:503,body:apiErrorBody('apiError.storageUnavailable')};return Response.json(answer.body,{status:answer.status});}};
 // requireMfa refuses an actor marked noMfa: a bad input must answer before it.
 const mfa={requireMfa:async(_request,actor)=>{if(actor.noMfa)throw new HttpError('apiError.mfa.loginRequired');},isMfaEnabled:async()=>true,mfaSessionFence:async()=>sql`TRUE`,requireLiveSessions:async()=>{},
  readMfaManagementProof:async(_request,actor,token)=>{if(typeof token!=='string')throw new HttpError('apiError.mfa.stepUpRequired');return {tokenHash:token,key:actor.principal,sessionHash:sha(actor.id+'mfa'),guard:sql`TRUE`};}};
 const transfers={sweepTransfers:async id=>{swept.push(id);},clearTransfer:async()=>{},verifyTransfer:async()=>{},transferAuthorizationGuard:()=>sql`TRUE`};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./mfa':mfa,'../identity/mfa':mfa,'./identity/mfa':mfa,'@/lib/server/identity/mfa':mfa,
  './transfers':transfers,'../devices/transfers':transfers,'@/lib/server/devices/transfers':transfers,
  '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
 const load=sourceLoader();
 const access=load('lib/server/identity/access.ts',imports);
 imports['./local-auth']=imports['./identity/local-auth']={primaryGuard:async(_request,actor)=>access.viewerWriteGuard(actor)};
 const consoleApi=load('app/api/console/route.ts',imports);
 const {effectiveAutomationForDevice}=load('lib/server/automation/automation-scopes.ts',imports);
 const {effectiveDeviceTags}=load('lib/server/devices/tag-store.ts',imports);
 const {pinnedDeviceIds}=load('lib/server/pinned-devices.ts',imports);
 const insert=(table,row)=>insertRow(d,table,row);
 const count=async statement=>Number((await d.one(statement)).n);
 // Customers B and C (insertRow turns "Multiple customers" on), X disabled.
 const customerB=uuid(),customerC=uuid(),customerX=uuid();
 for(const [id,name,status] of [[customerB,'Kunde B','active'],[customerC,'Kunde C','active'],[customerX,'Kunde X','disabled']])await insert('customers',{id,name,status,created_at:time(),updated_at:time()});
 const nameA=(await d.one(sql`SELECT name FROM customers WHERE id=${customerA}`)).name;
 const group=async(name,customer,parent=null)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time(),parent_id:parent,customer_id:customer});return id;};
 const gA=await group('A Server',customerA),gB=await group('B Server',customerB),gB2=await group('B Clients',customerB),gC=await group('C Server',customerC);
 const device=async(name,customer,groupId=null,extra={})=>{const id=uuid();await insert('servers',{id,name,token_hash:'token-'+id,created_at:time(),last_seen:time(),management:1,snapshot:'{"mode":"Management"}',agent_public_key:'key-'+id,description:'Desc '+name,customer_id:customer,...extra});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});return id;};
 /** An account with one role at one scope and its customers; noMfa marks it for the check that the input answers before MFA. */
 const account=async(label,permissions,{scope='global',scopeId='*',customers=[]}={})=>{
  const {actor,roleId,assignmentId}=await sourceActor(d,label,permissions,scope,scopeId);actor.userId=actor.id;
  await insert('mfa_sessions',{token_hash:sha(actor.id+'mfa'),principal:actor.principal,created_at:time(),last_activity:time(),idle_expires_at:time()+day,expires_at:time()+day});
  for(const customer of customers)await assign(actor,customer);
  return Object.assign(actor,{roleId,assignmentId});
 };
 const assign=(actor,customer)=>insert('customer_assignments',{customer_id:customer,principal_type:'user',principal_id:actor.id,created_at:time(),created_by:'fixture'});
 /** Another role assignment of an account. */
 const grant=async(actor,permissions,scope,scopeId,customerId=null)=>{const roleId=uuid(),id=uuid();await insert('rbac_roles',{id:roleId,name:'Role '+roleId,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time(),customer_id:customerId});await insert('role_assignments',{id,principal_type:'user',principal_id:actor.id,role_id:roleId,scope_type:scope,scope_id:scopeId,created_at:time(),created_by:'fixture'});return id;};
 const owner=await account('owner@move.test',['*']);
 const token=async actor=>{const value=uuid();await insert('mfa_management_proofs',{token_hash:value,principal:actor.principal,session_hash:sha(actor.id+'mfa'),expires_at:time()+300_000});return value;};
 const proofExists=async value=>await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${value}`)===1;
 /** POST /api/console with a fresh proof (managementToken null: none). */
 const post=async(actor,payload,{managementToken}={})=>{
  const value=managementToken===undefined?await token(actor):managementToken;viewer=actor;
  const response=await consoleApi.POST(new Request('https://portal.test/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,...(value===null?{}:{managementToken:value})})}));
  return {status:response.status,body:await response.json(),token:value};
 };
 const move=(ids,customerId,groupId=null,extra={})=>({action:'move-customer',ids,customerId,groupId,confirm:true,...extra});
 /** Runs `change` right before the next batch, then the request. */
 const beforeBatch=async(change,call)=>{hook={n:1,action:change};try{return await call();}finally{hook=null;}};
 /** The rows a refused move must leave as they are. */
 const state=async()=>({
  servers:await d.query(sql`SELECT id,customer_id,revoked,token_hash FROM servers ORDER BY id`),
  members:await d.query(sql`SELECT server_id,group_id FROM device_group_members ORDER BY server_id,group_id`),
  assignments:await count(sql`SELECT count(*) AS n FROM role_assignments`),
  audit:await count(sql`SELECT count(*) AS n FROM audit WHERE action=${action}`),
  jobs:await d.query(sql`SELECT id,state FROM jobs ORDER BY id`),
 });
 const audit=async()=>(await d.query(sql`SELECT target,server_id,scope,customer_id FROM audit WHERE action=${action} ORDER BY scope DESC,target`)).map(row=>({...row}));
 try{return await run({d,time,access,owner,account,assign,grant,device,group,token,proofExists,post,move,beforeBatch,state,audit,insert,count,swept,record,
  customerB,customerC,customerX,nameA,gA,gB,gB2,gC,effectiveAutomationForDevice,effectiveDeviceTags,pinnedDeviceIds});}
 finally{d.close();}
}

test('the input check answers 400 before MFA and the proof, and a move without a proof gets the step-up answer of a removal',async()=>fixture(async({owner,device,post,move,customerB,gB,state})=>{
 const id=await device('SRV-1',customerA);
 const blind={...owner,noMfa:true};
 const before=await state();
 for(const [payload,expected,label] of [
  [move('x',customerB,gB),refused.selectRange,'ids not an array'],
  [move([],customerB,gB),refused.selectRange,'no ids'],
  [move(Array.from({length:101},()=>crypto.randomUUID()),customerB,gB),refused.selectRange,'more than 100 ids'],
  [move([id,'not-a-guid'],customerB,gB),refused.selectRange,'an invalid id'],
  [move([id],customerB,gB,{confirm:'yes'}),refused.confirm,'confirm not true'],
  [move([id],'customer-b',gB),refused.customerInvalid,'customerId not a GUID'],
  [move([id],customerB,'group-b'),refused.groupInvalid,'groupId not a GUID'],
  [{action:'move-customer',ids:[id],customerId:customerB,confirm:true},refused.groupInvalid,'groupId missing'],
 ]){
  const sent=await post(blind,payload,{managementToken:null});
  assert.deepEqual(keyed(sent),expected,label+': 400 before requireMfa and the proof, never MFA_STEP_UP_REQUIRED');
 }
 assert.equal((await post(blind,move([id],customerB,gB),{managementToken:null})).body.messageKey,'apiError.mfa.loginRequired','a valid input reaches requireMfa');
 const missing=await post(owner,move([id],customerB,gB),{managementToken:null});
 const removal=await post(owner,{action:'remove-servers',ids:[id],confirm:true},{managementToken:null});
 assert.deepEqual(keyed(missing),refused.stepUp,'no managementToken: the step-up answer');
 assert.deepEqual(keyed(missing),keyed(removal),'the same answer as remove-servers');
 assert.deepEqual(await state(),before,'nothing changed');
}));

test('every refusal of the pre-check answers with its key and writes nothing',async()=>fixture(async({d,owner,account,device,post,move,state,proofExists,customerB,customerC,customerX,gA,gB,gC})=>{
 const tech=await account('tech@move.test',rights,{customers:[customerA,customerB]});
 const inA=await device('SRV-A',customerA,gA),inB=await device('SRV-B',customerB,gB),inC=await device('SRV-C',customerC,gC),gone=await device('SRV-GONE',customerA,null,{revoked:1});
 const noView=await account('groupview@move.test',rights,{scope:'devicegroup',scopeId:gA,customers:[customerA,customerB]});
 const loose=await device('SRV-LOOSE',customerA);
 const before=await state();
 const cases=[
  [owner,move([inA,crypto.randomUUID()],customerB,gB),refused.notFound,'an unknown device'],
  [owner,move([gone],customerB,gB),refused.notFound,'a removed device'],
  [tech,move([inC],customerB,gB),refused.notFound,'a device outside the customer boundary'],
  [noView,move([loose],customerB,gB),refused.notFound,'a device without view'],
  [owner,move([inA],crypto.randomUUID(),gB),refused.unavailable,'an unknown customer'],
  [tech,move([inA],customerC,null),refused.unavailable,'a customer outside the boundary'],
  [owner,move([inA],customerX,null),refused.disabled,'a disabled customer'],
  [owner,move([inA],customerB,crypto.randomUUID()),refused.groupNotFound,'an unknown group'],
  [tech,move([inA],customerB,gC),refused.groupNotFound,'a group outside the boundary'],
  [owner,move([inA],customerB,gA),refused.groupInvalid,'a group of another customer'],
 ];
 for(const [actor,payload,expected,label] of cases){
  const sent=await post(actor,payload);
  assert.deepEqual(keyed(sent),expected,label);
  assert.equal(await proofExists(sent.token),true,label+': the proof stays');
 }
 const same=await post(owner,move([inA,inB],customerB,gB));
 assert.deepEqual([...keyed(same),same.body.params],[...refused.sameCustomer,{name:'SRV-B'}],'a device already in the target customer names it');
 assert.deepEqual(await state(),before,'nothing changed');
 assert.equal(Number((await d.one(sql`SELECT count(*) AS n FROM audit`)).n),0,'no audit row');
}));

test('the rights on every device and on the target, and the cross-customer gate for several source customers',async()=>fixture(async({d,owner,account,grant,device,post,move,state,customerB,customerC,gA,gB,gB2,gC,audit})=>{
 const both=[customerA,customerB];
 const noGroups=await account('nogroups@move.test',['view','manage'],{customers:both});
 const noManage=await account('nomanage@move.test',['view','groups.manage'],{customers:both});
 // Group-scoped: both rights on A Server and B Server, none globally.
 const scoped=await account('scoped@move.test',rights,{scope:'devicegroup',scopeId:gA,customers:both});await grant(scoped,rights,'devicegroup',gB);
 const sourceOnly=await account('sourceonly@move.test',rights,{scope:'devicegroup',scopeId:gA,customers:both});
 const global=await account('global@move.test',rights,{customers:both});
 const before=await state();
 const one=await device('SRV-1',customerA,gA);
 for(const [actor,groupId,label] of [[noGroups,gB,'without groups.manage'],[noManage,gB,'without manage'],[sourceOnly,gB,'without a right on the target group'],[scoped,null,'"Ungrouped" without the global rights']]){
  const sent=await post(actor,move([one],customerB,groupId));
  assert.deepEqual(keyed(sent),refused.forbidden,label);
 }
 assert.deepEqual({...await state(),servers:undefined,members:undefined},{...before,servers:undefined,members:undefined},'the refusals wrote nothing');
 let sent=await post(scoped,move([one],customerB,gB));
 assert.deepEqual([sent.status,sent.body],[200,{ok:true,ids:[one],customerId:customerB,groupId:gB}],'a group-scoped technician with both rights on source and target group');
 const two=await device('SRV-2',customerA,gA),three=await device('SRV-3',customerA);
 sent=await post(global,move([three,two,three],customerB,null));
 assert.deepEqual([sent.status,sent.body],[200,{ok:true,ids:[three,two],customerId:customerB,groupId:null}],'"Ungrouped" with both rights globally; duplicates merged, request order');
 assert.equal(Number((await d.one(sql`SELECT count(*) AS n FROM device_group_members WHERE server_id IN (${two},${three})`)).n),0,'ungrouped devices have no membership');
 sent=await post(owner,move([one,two],customerC,gC));
 assert.equal(sent.status,200,'an Owner moves without further rights');
 // Two source customers: the gate without and with portal.msp.crossCustomer.
 const all=[customerA,customerB,customerC];
 const cross=await account('cross@move.test',rights,{customers:all});
 const fromA=await device('SRV-A',customerA),fromC=await device('SRV-C',customerC);
 const rows=(await audit()).length;
 sent=await post(cross,move([fromA,fromC],customerB,gB2));
 assert.deepEqual(keyed(sent),refused.crossRight,'two source customers without the right');
 assert.equal((await audit()).length,rows,'no row');
 await grant(cross,['portal.msp.crossCustomer'],'global','*');
 sent=await post(cross,move([fromA,fromC],customerB,gB2));
 assert.equal(sent.status,200,'with the right');
 assert.deepEqual((await d.query(sql`SELECT customer_id FROM servers WHERE id IN (${fromA},${fromC})`)).map(row=>row.customer_id),[customerB,customerB]);
}));

test('the admission is one live statement: a change between the pre-check and the commit writes nothing',async()=>fixture(async({d,owner,account,device,post,move,beforeBatch,state,proofExists,record,group,customerB,customerC,gA,gB,gB2})=>{
 const tech=await account('tech@move.test',rights,{customers:[customerA,customerB]});
 const one=await device('SRV-1',customerA,gA);
 const races=[
  ['the role is revoked',tech,null,()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${tech.assignmentId}`),refused.changed],
  ['the device is removed',owner,gB,()=>d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${one}`),refused.changed],
  ['the device moves elsewhere',owner,gB,async()=>{await d.exec(sql`DELETE FROM device_group_members WHERE server_id=${one}`);await d.exec(sql`UPDATE servers SET customer_id=${customerC} WHERE id=${one}`);},refused.changed],
  ['the target group is deleted',owner,gB2,()=>d.exec(sql`DELETE FROM device_groups WHERE id=${gB2}`),refused.changed],
  ['the target group gets a new parent',owner,gB,async()=>{const parent=await group('B Neu',customerB);await d.exec(sql`UPDATE device_groups SET parent_id=${parent} WHERE id=${gB}`);},refused.changed],
  ['the proof expires',owner,gB,()=>d.exec(sql`UPDATE mfa_management_proofs SET expires_at=0`),refused.proofExpired],
  ['the target customer is disabled',owner,gB,()=>d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${customerB}`),refused.disabled],
 ];
 for(const [label,actor,groupId,change,expected] of races){
  const before=await state();
  const sent=await beforeBatch(change,()=>post(actor,move([one],customerB,groupId)));
  assert.deepEqual(keyed(sent),expected,label);
  const after=await state();
  assert.deepEqual([after.members.filter(row=>row.server_id===one),after.audit,after.assignments],[label==='the device moves elsewhere'?[]:before.members.filter(row=>row.server_id===one),before.audit,before.assignments-(label==='the role is revoked'?1:0)],label+': no membership change, no audit row');
  assert.equal(after.servers.find(row=>row.id===one).customer_id,label==='the device moves elsewhere'?customerC:customerA,label+': servers.customer_id only as the race left it');
  assert.equal(await proofExists(sent.token),true,label+': the proof stays');
  // Undo the race for the next case.
  await d.exec(sql`UPDATE servers SET revoked=0,customer_id=${customerA} WHERE id=${one}`);
  await d.exec(sql`UPDATE customers SET status='active' WHERE id=${customerB}`);
  if(!(await d.one(sql`SELECT 1 AS member FROM device_group_members WHERE server_id=${one}`)))await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${one},${gA})`);
 }
 // The batch: the admission first, every later statement on its receipt.
 record.length=0;
 const sent=await post(owner,move([one],customerB,gB));
 assert.equal(sent.status,200);
 assert.equal(await proofExists(sent.token),false,'a successful move consumes the proof');
 const batch=record.at(-1);
 assert.match(batch[0],/^SELECT set_config\(/,'the first statement is the admission');
 assert.ok(batch.slice(1).every(text=>text.includes('current_setting(')),'every later statement runs on the receipt');
 // The used token cannot move another device.
 const other=await device('SRV-2',customerA,gA);
 assert.deepEqual(keyed(await post(owner,move([other],customerB,gB),{managementToken:sent.token})),refused.proofExpired,'a reused token is refused');
 assert.equal((await d.one(sql`SELECT customer_id FROM servers WHERE id=${other}`)).customer_id,customerA);
}));

test('a move ends what belongs to the old customer, keeps what describes the machine, and changes who sees the device',async()=>fixture(async({d,time,access,owner,account,grant,device,post,move,insert,count,swept,audit,customerB,nameA,gA,gB,effectiveAutomationForDevice,effectiveDeviceTags,pinnedDeviceIds})=>{
 const at=time();
 const moved=await device('SRV-MOVE',customerA,gA),other=await device('SRV-STAY',customerA,gA);
 const ta=await account('ta@move.test',['view'],{customers:[customerA]}),tb=await account('tb@move.test',['view'],{customers:[customerB]});
 const td=await account('td@move.test',['view'],{customers:[customerA,customerB]});await d.exec(sql`DELETE FROM role_assignments WHERE id=${td.assignmentId}`);
 // A customer role of A on the device itself, and a group role on A Server.
 const deviceAssignment=await grant(td,['view'],'device',moved,customerA);
 const tg=await account('tg@move.test',['view'],{scope:'devicegroup',scopeId:gA,customers:[customerA,customerB]});
 // Automation: a customer template of A on the device, and a group assignment on A Server.
 const template=async(slot,customerId)=>{const id=uuid();await insert('automation_templates',{id,kind:'desired',slot,name:'Template '+slot,payload:JSON.stringify({versionId:uuid(),intervalSeconds:300}),created_by:owner.principal,created_at:at,customer_id:customerId});return id;};
 const scopeAssignment=(templateId,slot,scopeType,scopeId)=>insert('automation_scope_assignments',{id:uuid(),kind:'desired',slot,scope_type:scopeType,scope_id:scopeId,template_id:templateId,actor:owner.principal,auth_version:1,created_at:at});
 await scopeAssignment(await template('device-slot',customerA),'device-slot','device',moved);
 await scopeAssignment(await template('group-slot',null),'group-slot','group',gA);
 await insert('desired_assignments',{id:uuid(),server_id:moved,version_id:uuid(),assigned_by:owner.principal,assigned_at:at,enabled:1,interval_seconds:3600});
 // Work: jobs, sessions, transfers, an AD sign-in, schedules and runs.
 const job=async state=>{const id=uuid();await insert('jobs',{id,server_id:moved,action:'refresh',target:'',parameters:'{"secret":1}',state,created_at:at,result:state==='succeeded'?'done':null,actor:owner.id,actor_email:owner.label,actor_principal:owner.principal});return id;};
 const pending=await job('pending'),running=await job('running'),succeeded=await job('succeeded');
 const terminal=uuid(),closedTerminal=uuid();
 await insert('terminal_sessions',{id:terminal,server_id:moved,principal:owner.principal,state:'open',cols:100,rows:30,created_at:at,last_activity:at,expires_at:at+day});
 await insert('terminal_sessions',{id:closedTerminal,server_id:moved,principal:owner.principal,state:'closed',cols:100,rows:30,created_at:at,last_activity:at,expires_at:at+day});
 await insert('terminal_frames',{id:terminal+':out:1',session_id:terminal,direction:'out',seq:1,data:'x',created_at:at});
 const rdp=uuid();
 await insert('rdp_sessions',{id:rdp,server_id:moved,principal:owner.principal,mfa_hash:sha(owner.id+'mfa'),state:'open',key_envelope:'envelope',key_hash:'hash',created_at:at,last_presence:at,expires_at:at+day});
 await insert('rdp_frames',{session_id:rdp,direction:'out',seq:1,data:'x',created_at:at});
 await insert('rdp_receipts',{session_id:rdp,direction:'in',seq:1,digest:'d'});
 const transfer=async state=>{const id=uuid();await insert('transfers',{id,server_id:moved,principal:owner.principal,direction:'download',path:'C:\\a.txt',state,overwrite:0,created_at:at,updated_at:at,expires_at:at+day});return id;};
 const openTransfer=await transfer('pending'),doneTransfer=await transfer('completed');
 await insert('plugin_ad_sessions',{id:uuid(),principal:owner.principal,session_hash:sha(owner.id+'mfa'),state:'active',source:'password',job_id:null,server_id:moved,directory_kind:'domain',directory_name:'corp.example',directory_sid:'S-1-5-21-1',user_sid:'S-1-5-21-1-1105',account:'CORP\\anna',created_at:at,verified_at:at,expires_at:at+day});
 const book=uuid(),version=uuid();
 await insert('runbooks',{id:book,name:'Runbook',description:'',created_at:at,created_by:owner.principal});
 await insert('runbook_versions',{id:version,runbook_id:book,version:1,definition:'{"steps":[],"parameters":[]}',created_at:at,created_by:owner.principal});
 const schedule=async targets=>{const id=uuid();await insert('runbook_schedules',{id,version_id:version,actor:owner.principal,targets:JSON.stringify(targets),parameters:'{}',sealed_secrets:JSON.stringify(Object.fromEntries(targets.map(target=>[target,'sealed']))),recurrence:'{"kind":"interval","minutes":60}',next_due:at+day,catchup_seconds:300,concurrency:1,failure_stop:1,approved_at:at,created_at:at});return id;};
 const shared=await schedule([moved,other]),alone=await schedule([moved]);
 const runOf=async devices=>{const id=uuid();await insert('runbook_runs',{id,version_id:version,actor:owner.principal,state:'running',parameters:'{}',concurrency:1,failure_stop:1,created_at:at,expires_at:at+day});for(const [server,state] of devices)await insert('runbook_run_devices',{run_id:id,server_id:server,state,sealed_secrets:'{"k":"v"}'});return id;};
 const queuedRun=await runOf([[moved,'queued'],[other,'succeeded']]),runningRun=await runOf([[moved,'running']]);
 // What describes the machine.
 await insert('samples',{server_id:moved,at,cpu:10,memory:20});
 await insert('device_software',{server_id:moved,key:'k',scope:'machine',architecture:'x64',name:'App',normalized_name:'app',first_seen:at,updated_at:at});
 await insert('device_drivers',{server_id:moved,key:'k',device_name:'Disk'});
 await insert('device_plugin_data',{server_id:moved,plugin:'dhcp',operation:'scopes',data:'{}',summary:'[]',collected_at:at,received_at:at});
 await insert('alerts',{id:uuid(),server_id:moved,rule_id:'cpu',key:'',state:'open',level:'warning',peak_level:'warning',params:'{}',started_at:at,opened_at:at});
 await insert('tags',{id:uuid(),scope_type:'device',scope_id:moved,name:'Rolle',name_key:'rolle',value:'DC',inherit:0,created_at:at,updated_at:at,updated_by:'fixture'});
 await insert('tags',{id:uuid(),scope_type:'group',scope_id:gA,name:'Standort',name_key:'standort',value:'Berlin',inherit:1,created_at:at,updated_at:at,updated_by:'fixture'});
 await insert('alert_rule_overrides',{id:uuid(),rule_id:'cpu',scope_type:'device',scope_id:moved,enabled:0,actor:'fixture',updated_at:at});
 await insert('os_esu_overrides',{id:uuid(),scope_type:'device',scope_id:moved,until:'2030-01-01',actor:'fixture',updated_at:at});
 await insert('drift_policies',{server_id:moved,id:uuid(),version:1,policy:'{}',created_at:at,updated_at:at,updated_by:'fixture'});
 const report=uuid();
 await insert('drift_reports',{id:report,server_id:moved,policy_version:1,scan_id:uuid(),received_at:at,scanned_at:at,complete:1,state:'baseline_missing',entries:'[]',changes:'[]',errors:'[]'});
 await insert('drift_baselines',{id:uuid(),server_id:moved,policy_version:1,report_id:report,entries:'[]',created_at:at,created_by:'fixture'});
 await insert('audit',{at,actor:'fixture',action:'Fixture',target:'earlier',server_id:moved,scope:'device'});
 await insert('account_pinned_devices',{user_id:ta.id,device_id:moved,created_at:at});
 await insert('agent_channels',{server_id:moved,last_at:at});
 await insert('device_token_nonces',{nonce_hash:'nonce',server_id:moved,expires_at:at+day});
 const kept=async()=>{
  const rows={};
  for(const table of ['samples','device_software','device_drivers','device_plugin_data','alerts','drift_policies','drift_baselines','drift_reports','agent_channels','device_token_nonces'])rows[table]=await d.query(sql`SELECT * FROM ${sql.ident(table)} WHERE server_id=${moved}`);
  for(const table of ['tags','alert_rule_overrides','os_esu_overrides'])rows[table]=await d.query(sql`SELECT * FROM ${sql.ident(table)} WHERE scope_type='device' AND scope_id=${moved}`);
  rows.audit=await d.query(sql`SELECT * FROM audit WHERE action='Fixture'`);
  rows.pins=await d.query(sql`SELECT * FROM account_pinned_devices`);
  rows.jobs=await d.query(sql`SELECT * FROM jobs WHERE id IN (${running},${succeeded}) ORDER BY id`);
  rows.otherRun=await d.query(sql`SELECT * FROM runbook_run_devices WHERE server_id=${moved} AND state='running'`);
  rows.runningRun=await d.query(sql`SELECT state,finished_at FROM runbook_runs WHERE id=${runningRun}`);
  rows.closedTerminal=await d.query(sql`SELECT * FROM terminal_sessions WHERE id=${closedTerminal}`);
  rows.doneTransfer=await d.query(sql`SELECT * FROM transfers WHERE id=${doneTransfer}`);
  return JSON.parse(JSON.stringify(rows));
 };
 const machine=sql`SELECT token_hash,agent_public_key,management,snapshot,last_seen,name,description,revoked FROM servers WHERE id=${moved}`;
 const keptBefore=await kept(),machineBefore=await d.one(machine),jobsBefore=await count(sql`SELECT count(*) AS n FROM jobs`);
 // Before: the inherited automation and tag apply, and the technicians of A see the device.
 const slots=async()=>(await effectiveAutomationForDevice(moved)).map(entry=>entry.slot).sort();
 const tagNames=async()=>((await effectiveDeviceTags([moved])).get(moved)??[]).map(tag=>tag.name).sort();
 assert.deepEqual([await slots(),await tagNames()],[['device-slot','group-slot'],['Rolle','Standort']],'before: device and group automation, own and inherited tag');
 for(const [actor,expected] of [[ta,true],[tb,false],[td,true],[tg,true]])assert.equal((await access.allowedDeviceIds(actor)).includes(moved),expected,actor.label+' before');
 assert.deepEqual(await pinnedDeviceIds(ta),[moved],'TA lists its pin before');

 const sent=await post(owner,move([moved],customerB,gB));
 assert.deepEqual([sent.status,sent.body],[200,{ok:true,ids:[moved],customerId:customerB,groupId:gB}],'the customer-role device assignment and the customer-template device automation do not block the move');
 // the device itself.
 assert.deepEqual([(await d.one(sql`SELECT customer_id FROM servers WHERE id=${moved}`)).customer_id,await d.one(machine)],[customerB,machineBefore],'new customer, the agent and its data unchanged');
 assert.deepEqual(await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${moved}`),[{group_id:gB}],'exactly the target membership');
 assert.equal(await count(sql`SELECT count(*) AS n FROM jobs`),jobsBefore,'no job is queued');
 // what ends.
 assert.equal(await count(sql`SELECT count(*) AS n FROM role_assignments WHERE scope_type='device' AND scope_id=${moved}`),0,'device role assignments end');
 assert.equal(await count(sql`SELECT count(*) AS n FROM role_assignments WHERE id=${deviceAssignment}`),0);
 assert.equal(await count(sql`SELECT count(*) AS n FROM automation_scope_assignments WHERE scope_type='device' AND scope_id=${moved}`),0,'device automation assignments end');
 assert.deepEqual(await d.query(sql`SELECT enabled,interval_seconds FROM desired_assignments WHERE server_id=${moved}`),[{enabled:0,interval_seconds:0}],'Desired State assignments are disabled');
 assert.deepEqual(await d.one(sql`SELECT state,parameters,result FROM jobs WHERE id=${pending}`),{state:'cancelled',parameters:'{}',result:reason},'the pending job is cancelled');
 assert.deepEqual(await d.one(sql`SELECT state,error FROM terminal_sessions WHERE id=${terminal}`),{state:'closed',error:reason},'the open terminal closes');
 assert.equal(await count(sql`SELECT count(*) AS n FROM terminal_frames WHERE session_id=${terminal}`),0,'its frames go');
 assert.deepEqual(await d.one(sql`SELECT state,error,key_envelope FROM rdp_sessions WHERE id=${rdp}`),{state:'closed',error:reason,key_envelope:null},'the open Remote Desktop session closes');
 assert.deepEqual([await count(sql`SELECT count(*) AS n FROM rdp_frames WHERE session_id=${rdp}`),await count(sql`SELECT count(*) AS n FROM rdp_receipts WHERE session_id=${rdp}`)],[0,0],'its frames and receipts go');
 assert.deepEqual(await d.one(sql`SELECT state,message FROM transfers WHERE id=${openTransfer}`),{state:'cancelled',message:reason},'the open transfer is cancelled');
 assert.deepEqual(swept,[moved],'sweepTransfers runs for the device after the commit');
 assert.equal(await count(sql`SELECT count(*) AS n FROM plugin_ad_sessions WHERE server_id=${moved}`),0,'the AD sign-in on the device ends');
 const schedules=new Map((await d.query(sql`SELECT id,targets,sealed_secrets,enabled FROM runbook_schedules`)).map(row=>[row.id,{targets:JSON.parse(row.targets),sealed:Object.keys(JSON.parse(row.sealed_secrets)),enabled:Number(row.enabled)}]));
 assert.deepEqual([schedules.get(shared),schedules.get(alone)],[{targets:[other],sealed:[other],enabled:1},{targets:[],sealed:[],enabled:0}],'the device leaves the schedules; an empty schedule is disabled');
 assert.deepEqual(await d.one(sql`SELECT state,result,sealed_secrets FROM runbook_run_devices WHERE run_id=${queuedRun} AND server_id=${moved}`),{state:'cancelled',result:reason,sealed_secrets:'{}'},'the queued runbook entry is cancelled');
 assert.equal((await d.one(sql`SELECT state FROM runbook_runs WHERE id=${queuedRun}`)).state,'cancelled','its run gets its final state');
 // what stays, row for row.
 assert.deepEqual(await kept(),keptBefore,'running and finished jobs, inventory, metrics, alarms, own tags, overrides, drift data, earlier audit rows, pins, channels and nonces stay');
 // the inherited group automation and tag no longer apply.
 assert.deepEqual([await slots(),await tagNames()],[[],['Rolle']],'after: no automation from the old group, only the own tag');
 // who sees the device.
 for(const [actor,expected] of [[ta,false],[tb,true],[td,false],[tg,false]])assert.equal((await access.allowedDeviceIds(actor)).includes(moved),expected,actor.label+' after');
 await assert.rejects(access.requireDevice(ta,moved),error=>error.messageKey==='apiError.device.notFound','TA gets 404');
 assert.deepEqual(await pinnedDeviceIds(ta),[],'the pin of TA is no longer listed');
 // one row in each customer's audit.
 assert.deepEqual(await audit(),[
  {target:`SRV-MOVE / ${moved} → Kunde B`,server_id:null,scope:'portal',customer_id:customerA},
  {target:`SRV-MOVE / ${moved} ← ${nameA}`,server_id:moved,scope:'device',customer_id:customerB},
 ],'a portal row in the source customer and a device row in the target customer');
}));
