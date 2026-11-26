// The device name against PostgreSQL: the pure rule of lib/device-name.ts, the
// automatic rename in the heartbeat batch (lib/server/agent/heartbeat.ts), the enrollment
// sources, POST /api/device-name and GET /api/console through the real routes,
// lib/server/devices/device-name-store.ts, lib/server/identity/access.ts and the audit writer. Covers the
// heartbeat admission (a refused heartbeat writes nothing), case-only names,
// custom and pending sources, previous names (limit, rename back), stored
// texts that keep the old name, the expected fence, rights from global and
// group scope, revoked and other-customer devices.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {deviceNamePattern,deviceNameMax,previousNameLimit,validDeviceName,reportedHostname,sameDeviceName,isDeviceNameSource} from '../../lib/device-name.ts';
import {boundaryPhase,everyCustomer} from '../support/customer-separation.mjs';

const uuid=()=>crypto.randomUUID(),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100';
let viewer=null,checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---- Pure rule ----
for(const name of ['SRV-APP01','Fileserver Berlin','srv_app.01','a','x'.repeat(64)])check(validDeviceName(name),name,`accepted: ${name}`);
for(const name of ['','   ','x'.repeat(65),'<b>','SRV\u0007','SRV\nAPP','Gerät','a/b',42,null,undefined])check(validDeviceName(name),null,`refused: ${JSON.stringify(name)}`);
check(validDeviceName('  SRV-APP01 \t'),'SRV-APP01','the name is trimmed');
check(reportedHostname({hostname:'  SRV-NEW  '}),'SRV-NEW','the reported computer name is trimmed');
check([reportedHostname({hostname:''}),reportedHostname({}),reportedHostname(null),reportedHostname({hostname:'bad<name>'})],[null,null,null,null],'no valid computer name');
check([sameDeviceName('SRV-APP01','srv-app01'),sameDeviceName('SRV-A','SRV-B')],[true,false],'case-only differences are the same name');
check([deviceNameMax,previousNameLimit,deviceNamePattern.source],[64,5,'^[a-zA-Z0-9._ -]{1,64}$'],'limits and rule');
check([isDeviceNameSource('hostname'),isDeviceNameSource('custom'),isDeviceNameSource('pending'),isDeviceNameSource('other')],[true,true,true,false],'name sources');

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
const access=load('lib/server/identity/access.ts',imports);
const nameApi=load('app/api/device-name/route.ts',imports),consoleApi=load('app/api/console/route.ts',imports);
const {recordHeartbeat}=load('lib/server/agent/heartbeat.ts',imports),{enrollDevice}=load('lib/server/console-data.ts',imports);

const time=Date.now();
const insert=(table,row)=>insertRow(d,table,row);
async function persona(name){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@name.test',display_name:name,auth_principal:principal,auth_email:name+'@name.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@name.test',principal});
}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){const id=uuid();await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${id},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);return id;}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};

// Devices with an agent token, so heartbeats pass the admission; the source defaults to the column default.
const tokens=new Map();
async function device(name,{source,groupId=null,customer=customerA,snapshot}={}){
 const id=uuid(),token=uuid();tokens.set(id,hash(token));
 await insert('servers',{id,name,token_hash:hash(token),token_expires_at:time+86400000,created_at:time,last_seen:null,management:1,customer_id:customer,...(source?{name_source:source}:{}),...(snapshot?{snapshot:JSON.stringify(snapshot)}:{})});
 if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});
 return id;
}
// Every heartbeat 20 s after the previous one, so the 10 s interval admits it.
let clock=time;
const heartbeat=(id,hostname,{at,omit=false}={})=>{if(at===undefined)clock+=20000;
 return recordHeartbeat({serverId:id,tokenHash:tokens.get(id),time:at??clock,publicKey:'fixture-key',snapshot:JSON.stringify(hostname===undefined?{}:{hostname}),...(omit?{}:{hostname}),management:true,capabilities:[],runningJobs:[]});};
const row=async id=>({...(await d.one(sql`SELECT name,name_source AS source FROM servers WHERE id=${id}`))});
const previous=async id=>(await d.query(sql`SELECT name FROM device_previous_names WHERE server_id=${id} ORDER BY replaced_at DESC,name_key`)).map(entry=>entry.name);
const audits=async id=>(await d.query(sql`SELECT actor,action,target,server_id AS "serverId",scope FROM audit WHERE server_id=${id} AND action LIKE 'device.name.%' ORDER BY id`)).map(entry=>({...entry,target:JSON.parse(entry.target)}));
const state=async id=>({...(await row(id)),previous:await previous(id),audits:(await audits(id)).length});

const post=async(as,body)=>{viewer=as;const response=await nameApi.POST(new Request('https://name.test/api/device-name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
const rename=(as,serverId,source,expected,name)=>post(as,{serverId,source,expected,...(name===undefined?{}:{name})});
const consoleServers=async as=>{viewer=as;const response=await consoleApi.GET(new Request('https://name.test/api/console'));assert.equal(response.status,200,'console GET');return Object.fromEntries((await response.json()).servers.map(s=>[s.id,s]));};
async function refused(promise,status,code,label,id){
 const before=await state(id);
 const result=await promise;
 check(result.status,status,label);if(code!==undefined)check(result.body.code,code,label+' code');
 check(await state(id),before,label+' leaves name, source, previous names and audit unchanged');
 return result;
}

try{
 // ---- Automatic rename ----
 const follow=await device('SRV-OLD');
 check((await row(follow)).source,'hostname','the column default is hostname');
 check(await heartbeat(follow,'SRV-OLD'),true,'a heartbeat with the same name is stored');
 check(await state(follow),{name:'SRV-OLD',source:'hostname',previous:[],audits:0},'the same name changes nothing');
 const renamedAt=clock+20000;
 check(await heartbeat(follow,'  SRV-NEW  '),true,'the renaming heartbeat is stored and still reports it');
 check(await row(follow),{name:'SRV-NEW',source:'hostname'},'the name follows the trimmed computer name');
 check(await audits(follow),[{actor:'System',action:'device.name.hostname',target:{old:'SRV-OLD',new:'SRV-NEW'},serverId:follow,scope:'device'}],'exactly one device audit row');
 check(Number((await d.one(sql`SELECT at FROM audit WHERE server_id=${follow} AND action='device.name.hostname'`)).at),renamedAt,'the audit row carries the heartbeat time');
 check(await previous(follow),['SRV-OLD'],'the old name is a previous name');
 check(Number((await d.one(sql`SELECT replaced_at FROM device_previous_names WHERE server_id=${follow}`)).replaced_at),renamedAt,'replaced_at is the heartbeat time');

 // ---- No rename ----
 check(await heartbeat(follow,'srv-new'),true,'a case-only change is stored');
 check(await state(follow),{name:'SRV-NEW',source:'hostname',previous:['SRV-OLD'],audits:1},'a case-only change never renames');
 for(const hostname of ['','   ','bad<name>','x'.repeat(65),42,undefined]){
  check(await heartbeat(follow,hostname),true,`a heartbeat with ${JSON.stringify(hostname)} is stored`);
  check(await state(follow),{name:'SRV-NEW',source:'hostname',previous:['SRV-OLD'],audits:1},`no rename for ${JSON.stringify(hostname)}`);
 }
 // Inside the 10 s interval: refused as a whole.
 check(await heartbeat(follow,'SRV-TOO-SOON',{at:clock+5000}),false,'a heartbeat inside 10 s is refused');
 check(await state(follow),{name:'SRV-NEW',source:'hostname',previous:['SRV-OLD'],audits:1},'a refused heartbeat writes no name, previous name or audit');
 // A wrong token: refused.
 clock+=20000;
 check(await recordHeartbeat({serverId:follow,tokenHash:hash('wrong'),time:clock,publicKey:'fixture-key',snapshot:JSON.stringify({hostname:'SRV-WRONG'}),hostname:'SRV-WRONG',management:true,capabilities:[],runningJobs:[]}),false,'a heartbeat with a wrong token is refused');
 check((await row(follow)).name,'SRV-NEW','a wrong token renames nothing');
 // Another key than the pinned one: refused.
 check(await recordHeartbeat({serverId:follow,tokenHash:tokens.get(follow),time:clock,publicKey:'other-key',snapshot:JSON.stringify({hostname:'SRV-KEY'}),hostname:'SRV-KEY',management:true,capabilities:[],runningJobs:[]}),false,'a heartbeat with another key is refused');
 check(await state(follow),{name:'SRV-NEW',source:'hostname',previous:['SRV-OLD'],audits:1},'another key renames nothing');
 // Without the hostname field the snapshot text is read.
 check(await heartbeat(follow,'SRV-SNAP',{omit:true}),true,'stored without the hostname field');
 check((await row(follow)).name,'SRV-SNAP','the computer name comes from the snapshot text');

 // ---- Rename back and the limit ----
 check(await heartbeat(follow,'SRV-NEW'),true,'rename back');
 check(await previous(follow),['SRV-SNAP','SRV-OLD'],'renaming back to a previous name removes it from the list');
 for(const name of ['SRV-A','SRV-B','SRV-C','SRV-D','SRV-E'])await heartbeat(follow,name);
 check((await row(follow)).name,'SRV-E','the last name');
 check(await previous(follow),['SRV-D','SRV-C','SRV-B','SRV-A','SRV-NEW'],'only the 5 newest previous names stay');
 check((await audits(follow)).length,8,'one audit row per rename');

 // ---- Stored texts keep the old name ----
 const texts=await device('SRV-TEXT');
 await d.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${time},'owner','Device updated','SRV-TEXT',${texts},'device')`);
 const job=uuid();
 await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,claimed_at,actor,actor_email,actor_principal,parameters) VALUES (${job},${texts},'refresh','SRV-TEXT','succeeded',${time},${time},'owner','owner@name.test','private:owner@name.test','{}')`);
 await heartbeat(texts,'SRV-TEXT2');
 check((await row(texts)).name,'SRV-TEXT2','renamed');
 check((await d.one(sql`SELECT target FROM audit WHERE server_id=${texts} AND action='Device updated'`)).target,'SRV-TEXT','an existing audit row keeps its target');
 check((await d.one(sql`SELECT target FROM jobs WHERE id=${job}`)).target,'SRV-TEXT','a job keeps its target');

 // ---- Custom name survives every heartbeat ----
 const custom=await device('Fileserver Berlin',{source:'custom'});
 check(await heartbeat(custom,'SRV-FS99'),true,'stored');
 check(await state(custom),{name:'Fileserver Berlin',source:'custom',previous:[],audits:0},'a custom name stays');

 // ---- Enrollment and pending ----
 const enroll=async name=>{const id=uuid(),token=uuid();tokens.set(id,hash(token));await enrollDevice({id,name,tokenHash:hash(token),createdAt:time,expiresAt:time+86400000,groupId:null,customerId:customerA},sql`TRUE`,null);return id;};
 const same=await enroll('srv-pending'),other=await enroll('My Server'),invalid=await enroll('SRV-INVALID');
 check([(await row(same)).source,(await row(other)).source],['pending','pending'],'personal registration stores pending');
 check(await heartbeat(same,'SRV-PENDING'),true,'stored');
 check(await state(same),{name:'srv-pending',source:'hostname',previous:[],audits:0},'pending resolves to hostname for the same name in another case, without a rename or audit');
 check(await heartbeat(other,'SRV-REAL'),true,'stored');
 check(await state(other),{name:'My Server',source:'custom',previous:[],audits:0},'pending resolves to custom for another name');
 check(await heartbeat(invalid,''),true,'stored');
 check(await state(invalid),{name:'SRV-INVALID',source:'custom',previous:[],audits:0},'pending without a valid computer name resolves to custom');
 const early=await enroll('SRV-EARLY');
 await heartbeat(early,'SRV-EARLY');check(await heartbeat(early,'SRV-LATE',{at:clock+5000}),false,'refused');
 check(await state(early),{name:'SRV-EARLY',source:'hostname',previous:[],audits:0},'the refused heartbeat keeps the resolved state');
 const refusedPending=await enroll('SRV-WAIT');
 await heartbeat(refusedPending,'SRV-WAIT');await d.exec(sql`UPDATE servers SET name_source='pending' WHERE id=${refusedPending}`);
 check(await heartbeat(refusedPending,'OTHER',{at:clock+5000}),false,'refused inside 10 s');
 check((await row(refusedPending)).source,'pending','a refused heartbeat does not resolve pending');
 // The resolved device follows the next computer rename.
 await heartbeat(same,'SRV-PENDING2');
 check(await state(same),{name:'SRV-PENDING2',source:'hostname',previous:['srv-pending'],audits:1},'after resolving, the next rename follows');

 // ---- Manual rename ----
 const parent=await group('Parent',null),child=await group('Child',parent);
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const groupB=await group('B group',null,customerB);
 const dev1=await device('SRV-ONE',{groupId:child,snapshot:{hostname:'SRV-ONE'}}),dev2=await device('SRV-TWO',{groupId:parent}),devB=await device('SRV-B',{groupId:groupB,customer:customerB});
 const owner=await persona('owner'),operator=await persona('operator'),manager=await persona('manager'),parentManager=await persona('parent-manager'),technician=await persona('technician');
 await grant(owner,await role('Owner',['*']),'global');
 await grant(operator,await role('Operator',access.rolePermissions.operator),'global');
 await grant(manager,await role('Groups everywhere',['view','groups.manage']),'global');
 await grant(parentManager,await role('Groups on parent',['view','groups.manage']),'devicegroup',parent);
 await grant(technician,await role('Technician',['view','groups.manage']),'global');
 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 let result=await rename(manager,dev1,'custom','SRV-ONE','  Fileserver Berlin ');
 check([result.status,result.body],[200,{ok:true,name:'Fileserver Berlin',nameSource:'custom'}],'a custom name is stored trimmed');
 check(await audits(dev1),[{actor:'manager@name.test',action:'device.name.set',target:{old:'SRV-ONE',new:'Fileserver Berlin'},serverId:dev1,scope:'device'}],'one audit row with the viewer label');
 check(await previous(dev1),['SRV-ONE'],'the old name is a previous name');
 await heartbeat(dev1,'SRV-ONE-NEW');
 check(await state(dev1),{name:'Fileserver Berlin',source:'custom',previous:['SRV-ONE'],audits:1},'the heartbeat keeps the custom name');
 result=await rename(manager,dev1,'custom','Fileserver Berlin','Fileserver Berlin');
 check([result.status,result.body],[200,{ok:true,name:'Fileserver Berlin',nameSource:'custom'}],'an unchanged request answers ok');
 check(await state(dev1),{name:'Fileserver Berlin',source:'custom',previous:['SRV-ONE'],audits:1},'an unchanged request writes nothing');
 // Back to the computer name: the stored snapshot has SRV-ONE-NEW.
 result=await rename(manager,dev1,'hostname','Fileserver Berlin');
 check([result.status,result.body],[200,{ok:true,name:'SRV-ONE-NEW',nameSource:'hostname'}],'the switch takes the reported computer name at once');
 check((await audits(dev1))[1],{actor:'manager@name.test',action:'device.name.hostname',target:{old:'Fileserver Berlin',new:'SRV-ONE-NEW'},serverId:dev1,scope:'device'},'the switch writes device.name.hostname');
 check(await previous(dev1),['Fileserver Berlin','SRV-ONE'],'the custom name becomes a previous name');
 result=await rename(manager,dev1,'hostname','SRV-ONE-NEW');
 check([result.status,(await audits(dev1)).length],[200,2],'switching to the source it has writes nothing');
 // Without a snapshot the name stays until the next heartbeat.
 result=await rename(manager,dev2,'custom','SRV-TWO','Two');
 check(result.status,200,'custom on a device without snapshot');
 result=await rename(manager,dev2,'hostname','Two');
 check([result.status,result.body],[200,{ok:true,name:'Two',nameSource:'hostname'}],'without a snapshot only the source changes');
 check((await audits(dev2)).map(entry=>[entry.action,entry.target]),[['device.name.set',{old:'SRV-TWO',new:'Two'}],['device.name.hostname',{old:'Two',new:'Two'}]],'the switch is audited');
 check(await previous(dev2),['SRV-TWO'],'no previous name when the name stays');
 await heartbeat(dev2,'SRV-TWO-PC');
 check((await row(dev2)).name,'SRV-TWO-PC','the next heartbeat applies the computer name');
 // A custom name that only changes the case.
 result=await rename(manager,dev2,'custom','SRV-TWO-PC','srv-two-pc');
 check([result.status,result.body.name],[200,'srv-two-pc'],'a case-only custom name is stored');
 check(await previous(dev2),['Two','SRV-TWO'],'a case-only change records no previous name of the same key');

 // ---- Errors ----
 await refused(rename(manager,dev1,'custom','stale','Other'),409,'DEVICE_NAME_CHANGED','stale expected',dev1);
 db.beforeNextTransaction(()=>d.exec(sql`UPDATE servers SET name='Changed meanwhile' WHERE id=${dev1}`));
 result=await rename(manager,dev1,'custom','SRV-ONE-NEW','Mine');
 check([result.status,result.body.code],[409,'DEVICE_NAME_CHANGED'],'a change between check and commit fails the fence');
 check(await state(dev1),{name:'Changed meanwhile',source:'hostname',previous:['Fileserver Berlin','SRV-ONE'],audits:2},'the concurrent name stays, nothing else is written');
 for(const name of ['','   ','<b>','x'.repeat(65),'Gerät',42,undefined])await refused(rename(manager,dev1,'custom','Changed meanwhile',name),400,'DEVICE_NAME_INVALID',`invalid name ${JSON.stringify(name)}`,dev1);
 await refused(post(manager,{serverId:dev1,source:'other',expected:'Changed meanwhile'}),400,'INVALID_REQUEST','unknown source',dev1);
 await refused(post(manager,{serverId:dev1,source:'hostname'}),400,'INVALID_REQUEST','missing expected',dev1);
 check([(await rename(manager,'not-a-guid','hostname','x')).status,(await rename(manager,'not-a-guid','hostname','x')).body.code],[400,'INVALID_REQUEST'],'invalid device id');
 check((await rename(owner,uuid(),'hostname','x')).body.code,'NOT_FOUND','unknown device');

 // ---- Rights ----
 await refused(rename(operator,dev1,'custom','Changed meanwhile','Op'),403,undefined,'Operator (no groups.manage) is refused',dev1);
 result=await rename(parentManager,dev1,'custom','Changed meanwhile','From the group');
 check([result.status,result.body.name],[200,'From the group'],'groups.manage from an ancestor group scope is accepted');
 result=await rename(owner,dev1,'hostname','From the group');
 check(result.status,200,'Owner allowed');

 // ---- Console read ----
 const servers=await consoleServers(owner);
 check([servers[follow].nameSource,servers[follow].previousNames],['hostname',['SRV-D','SRV-C','SRV-B','SRV-A','SRV-NEW']],'GET /api/console returns the source and the previous names newest first');
 check([servers[custom].nameSource,servers[custom].previousNames],['custom',[]],'a custom device without previous names');
 check(servers[refusedPending].nameSource,'pending','pending is returned');

 // ---- Revoked device and the customer boundary ----
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${dev2}`);
 await refused(rename(owner,dev2,'custom','srv-two-pc','Back again'),404,'NOT_FOUND','a revoked device answers 404',dev2);
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 await refused(rename(technician,devB,'custom','SRV-B','Other customer'),404,undefined,'a device of another customer is refused',devB);
 console.log(`PASS device name (${checks} checks): rule, heartbeat rename with admission, case-only, invalid and custom names, pending, previous names with limit and rename back, stored texts, enrollment sources, manual rename with audit, fence, validation, rights, console read, revoked and other-customer devices.`);
}finally{await d.close();}
