// effectivePermissions answers permissionsFor for many devices in one
// statement, the console builds its permission map with it, and the device audit
// checks the rights once per device and query instead of once per audit row.
// Real lib/server/identity/access.ts, feature-authorization, policy/can and audit-scope against
// isolated PostgreSQL test databases; db() is a facade that counts statements.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {budgeted,budgetText} from '../support/load-budget.mjs';
import {compile,sql} from '../../runtime/database.mjs';
import {boundaryPhase,everyCustomer} from '../support/customer-separation.mjs';

const uuid=()=>crypto.randomUUID(),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100';
// A seeded Park-Miller generator, so the random part is the same on every run.
const random=seed=>{let state=seed;return ()=>(state=state*48271%2147483647)/2147483647;};
let current=null,prepares=0,auditHook=null,viewer=null,checks=0;
// Signed-in viewers carry the authorization stamp of their account (auth_version 1).
const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
// db() is a facade over the current test database that counts statements; the
// hook runs once, right before the console's device audit query reads.
const countedHandle=target=>({
 query:statement=>run(target,'query',statement),one:statement=>run(target,'one',statement),exec:statement=>run(target,'exec',statement),
});
async function run(target,kind,statement){
 prepares++;
 if(auditHook&&compile(statement).text.includes('audit_target')){const hook=auditHook;auditHook=null;await hook();}
 return target[kind](statement);
}
const facade={...countedHandle({query:s=>current.query(s),one:s=>current.one(s),exec:s=>current.exec(s)}),transaction:(callback,options)=>current.transaction(tx=>callback(countedHandle(tx)),options),close:async()=>{}};
// A new test database becomes the current one behind the facade.
const nextDatabase=async()=>{current=await sourceDatabase();databases.push(current);globalThis[Symbol.for('serverdesk.runtime.database')]=facade;};
const HttpError=realHttpError;
const server={db:()=>facade,now:()=>Date.now(),config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>hash(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
 body:request=>request.json(),sameOrigin:()=>{},requireViewer:async()=>stamped({...viewer}),log:async()=>{},
 failure:error=>Response.json({error:error.message,code:error.code},{status:error.status??503})};
const mfa={requireLiveSessions:async()=>{},requireMfa:async()=>{},isMfaEnabled:async()=>true,readMfaManagementProof:async()=>({guard:sql`TRUE`})};
const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../identity/mfa':mfa,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,
 '../agent/agent-protocol':{maintenanceBusy:async()=>false},'@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},
 '@/lib/management':{operations:{},safeTarget:()=>''},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},
 '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
 '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},
 '@/lib/diagnostics':{diagnosticDefinitions:{},diagnosticSecurityAccess:()=>false,isDiagnosticKind:()=>false},'@/lib/file-operations':{fileSecurityAccess:()=>false},
 '@/lib/server/devices/device-lifecycle':{removeDevice:async()=>({}),removeDevices:async()=>({}),sweepRemovedTransfers:async()=>{}},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
const load=sourceLoader();
const access=load('lib/server/identity/access.ts',imports);
load('lib/server/identity/feature-authorization.ts',imports);load('lib/server/identity/policy/can.ts',imports);
const auditScope=load('lib/server/audit-scope.ts',imports);
const consoleApi=load('app/api/console/route.ts',imports);

const insert=(table,row)=>insertRow(current,table,row);
// The console's permission and device audit part, as app/api/console/route.ts
// builds it, through db() so prepares counts its statements. The console skips
// the audit query without audit devices; here it always runs (with no ids it
// reads no row), so every viewer runs the same statements.
async function rightsAndAudit(p,visible){
 const permissionMap=await access.effectivePermissions(p,visible),auditDevices=visible.filter(id=>{const rights=permissionMap.get(id)??[];return rights.includes('view')&&rights.includes('security.events');});
 const rows=await facade.query(sql`${auditScope.auditSelect} WHERE ${auditScope.deviceAuditGuard(p,auditDevices)} ORDER BY a.at DESC,a.id DESC LIMIT 200`);
 return {permissionMap,auditDevices,rows};
}
const time=Date.now();
async function persona(name,status='active'){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@batched.test',display_name:name,auth_principal:principal,auth_email:name+'@batched.test',status,auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@batched.test',principal});
}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions,builtin:0,created_at:time});return id;}
const grant=(type,principalId,roleId,scopeType,scopeId)=>current.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},${type},${principalId},${roleId},${scopeType},${scopeType==='global'?'*':scopeId},${time},${'fixture'}) ON CONFLICT DO NOTHING`);
const assignCustomer=(customer,type,id)=>current.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customer},${type},${id},${time},${'fixture'}) ON CONFLICT DO NOTHING`);
async function group(id,name,parent,customer){await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;}
async function device(id,name,customer,groupId){await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,customer_id:customer});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});return id;}
// Compare for every id: exactly the distinct ids as keys, each value as permissionsFor.
async function equivalent(v,ids,label){
 const map=await access.effectivePermissions(v,ids);
 check([...map.keys()],[...new Set(ids)],label+': one key per distinct id');
 for(const id of new Set(ids))check(map.get(id),await access.permissionsFor(v,id),`${label}: ${id}`);
 return map;
}

const databases=[];
try{
 // ---- Fixed fixture -------------------------------------------------
 await nextDatabase();
 const customerB=uuid();await insert('customers',{id:customerB,name:'Kunde B',created_at:time,updated_at:time});
 const gRoot=await group(uuid(),'Wurzel',null,customerA),gD1=await group(uuid(),'Ebene 1',gRoot,customerA),gMid=await group(uuid(),'Mitte',gD1,customerA),gD3=await group(uuid(),'Ebene 3',gMid,customerA),gLeaf=await group(uuid(),'Blatt',gD3,customerA);
 const gSib=await group(uuid(),'Geschwister',gRoot,customerA),gB=await group(uuid(),'Kunde B',null,customerB),gB1=await group(uuid(),'Kunde B Kind',gB,customerB);
 const groups=[gRoot,gD1,gMid,gD3,gLeaf,gSib,gB,gB1];
 const dRoot=await device(uuid(),'Root',customerA,gRoot),dD1=await device(uuid(),'D1',customerA,gD1),dMid=await device(uuid(),'Mitte',customerA,gMid),dLeaf=await device(uuid(),'Blatt',customerA,gLeaf);
 const dSib=await device(uuid(),'Geschwister',customerA,gSib),dUngrouped=await device(uuid(),'Ohne Gruppe',customerA,null),dRevoked=await device(uuid(),'Entfernt',customerA,gD3);
 const dB=await device(uuid(),'B',customerB,gB1),dB2=await device(uuid(),'B2',customerB,gB);
 await current.exec(sql`UPDATE servers SET revoked=1 WHERE id=${dRevoked}`);
 const unknown=uuid(),devices=[dRoot,dD1,dMid,dLeaf,dSib,dUngrouped,dRevoked,dB,dB2],ids=[...devices,unknown,dLeaf,unknown];
 // Role pool: '*', the runbooks alias, an empty list, invalid JSON, a JSON value that is no list, and plain rights.
 const rAll=await role('Alle','["*"]'),rRunbooks=await role('Runbooks','["runbooks","view"]'),rEmpty=await role('Leer','[]');
 // Stored invalid JSON: the CHECK is dropped for the insert and added again without validating old rows.
 await current.exec(sql`ALTER TABLE rbac_roles DROP CONSTRAINT rbac_roles_permissions`);const rInvalid=await role('Kaputt','["view",');await current.exec(sql`ALTER TABLE rbac_roles ADD CONSTRAINT rbac_roles_permissions CHECK (permissions IS JSON) NOT VALID`);
 const rObject=await role('Objekt','{"view":true}'),rRead=await role('Lesen','["view","security.events"]'),rDiag=await role('Diagnose','["diagnose","files.read","drift.read"]');
 const pool=[rAll,rRunbooks,rEmpty,rInvalid,rObject,rRead,rDiag];
 check(await current.one(sql`SELECT (CASE WHEN permissions IS JSON THEN 1 ELSE 0 END) AS valid FROM rbac_roles WHERE id=${rInvalid}`).then(row=>row===null?null:row.valid),0,'the fixture really holds invalid role JSON');
 const teamOn=uuid(),teamOff=uuid();
 await insert('user_groups',{id:teamOn,name:'Team an',description:'',enabled:1,created_at:time});await insert('user_groups',{id:teamOff,name:'Team aus',description:'',enabled:0,created_at:time});
 const pDevice=await persona('device');await grant('user',pDevice.id,rRead,'device',dLeaf);await grant('user',pDevice.id,rDiag,'device',dB);await grant('user',pDevice.id,rRunbooks,'device',dUngrouped);await grant('user',pDevice.id,rEmpty,'device',dRevoked);await assignCustomer(customerA,'user',pDevice.id);
 const pGroups=await persona('groups');await grant('user',pGroups.id,rRunbooks,'devicegroup',gRoot);await grant('user',pGroups.id,rRead,'devicegroup',gMid);await grant('user',pGroups.id,rDiag,'devicegroup',gLeaf);await grant('user',pGroups.id,rEmpty,'devicegroup',gB);await assignCustomer(customerA,'user',pGroups.id);await assignCustomer(customerB,'user',pGroups.id);
 const pGlobal=await persona('global');await grant('user',pGlobal.id,rRead,'global');await grant('user',pGlobal.id,rInvalid,'global');await grant('user',pGlobal.id,rObject,'global');await assignCustomer(customerA,'user',pGlobal.id);
 const pTeam=await persona('team');for(const team of [teamOn,teamOff])await insert('user_group_members',{group_id:team,user_id:pTeam.id});
 await grant('group',teamOn,rDiag,'devicegroup',gSib);await grant('group',teamOn,rAll,'device',dB);await grant('group',teamOff,rAll,'global');await grant('user',pTeam.id,rRead,'devicegroup',gB);await assignCustomer(customerB,'group',teamOn);await assignCustomer(customerA,'group',teamOff);
 const pInactive=await persona('inactive','disabled');await grant('user',pInactive.id,rAll,'global');await assignCustomer(customerA,'user',pInactive.id);
 const pOwner=await persona('owner');await grant('user',pOwner.id,rAll,'global');
 const pRunbooks=await persona('runbooks');await grant('user',pRunbooks.id,rRunbooks,'global');await grant('user',pRunbooks.id,rEmpty,'device',dRoot);
 const pInvalid=await persona('invalid');await grant('user',pInvalid.id,rInvalid,'device',dRoot);await grant('user',pInvalid.id,rInvalid,'devicegroup',gRoot);await grant('user',pInvalid.id,rObject,'devicegroup',gMid);await assignCustomer(customerA,'user',pInvalid.id);
 const fixed={pDevice,pGroups,pGlobal,pTeam,pInactive,pOwner,pRunbooks,pInvalid};
 // ---- Seeded random personas, 1-5 assignments each ------------------------
 const next=random(45045),pick=list=>list[Math.floor(next()*list.length)],randomPersonas=[];
 for(let n=0;n<12;n++){
  const p=await persona('random-'+n),count=1+Math.floor(next()*5);
  // Some reach their roles or customer through an own user group, enabled or not.
  const team=uuid();await insert('user_groups',{id:team,name:'Zufall '+n,description:'',enabled:next()<0.7?1:0,created_at:time});await insert('user_group_members',{group_id:team,user_id:p.id});
  for(let i=0;i<count;i++){
   const scope=pick(['global','device','devicegroup']),subject=next()<0.25?['group',team]:['user',p.id];
   await grant(subject[0],subject[1],pick(pool),scope,scope==='device'?pick(devices):scope==='devicegroup'?pick(groups):'*');
  }
  for(const customer of [customerA,customerB]){const draw=next();if(draw<0.35)await assignCustomer(customer,'user',p.id);else if(draw<0.5)await assignCustomer(customer,'group',team);}
  randomPersonas.push(p);
 }
 const assignments=await current.query(sql`SELECT count(*) AS n FROM role_assignments ra JOIN local_users u ON u.id=ra.principal_id OR ra.principal_id IN (SELECT group_id FROM user_group_members WHERE user_id=u.id) WHERE u.username LIKE 'random-%' GROUP BY u.id`).then(results=>({results}));
 check(assignments.results.every(row=>row.n>=1&&row.n<=5),true,'every random persona has 1-5 assignments');

 const compareAll=async mode=>{
  for(const [name,p] of Object.entries(fixed))await equivalent(p,ids,`${mode} ${name}`);
  const shapes=new Set();
  for(const p of randomPersonas)for(const rights of (await equivalent(p,ids,`${mode} ${p.label}`)).values())shapes.add(JSON.stringify(rights));
  check(shapes.size>=4&&shapes.has('[]'),true,`${mode}: the random personas reach several different right sets (${shapes.size})`);
 };
 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await current.exec(everyCustomer(time));
 await compareAll('every customer');
 {
  const global=await access.effectivePermissions(pGlobal,[dUngrouped,dB]),owner=await access.effectivePermissions(pOwner,[dLeaf]),runbooks=await access.effectivePermissions(pRunbooks,[dRoot]);
  check(global.get(dUngrouped),['view','security.events'],'every customer: a device gets the global rights; invalid and non-list role JSON add nothing');
  check(global.get(dB),['view','security.events'],'every customer: the boundary hides nothing');
  check(owner.get(dLeaf),access.allPermissions,"every customer: '*' gives every right");
  check(['runbooks','runbooks.read','runbooks.execute'].every(right=>runbooks.get(dRoot).includes(right)),true,'every customer: runbooks adds runbooks.read and runbooks.execute');
  check([...(await access.effectivePermissions(pInactive,ids)).values()].every(rights=>rights.length===0),true,'every customer: an inactive user has no rights');
  check((await access.effectivePermissions(pTeam,[dRoot])).get(dRoot),[],'every customer: a disabled user group gives nothing');
 }
 await current.exec(boundaryPhase());
 await compareAll('boundary');
 {
  const device=await access.effectivePermissions(pDevice,[dB,dLeaf]),team=await access.effectivePermissions(pTeam,[dB,dSib]);
  check((await access.effectivePermissions(pGlobal,[unknown])).get(unknown),[],'boundary: an unknown id has no customer and no rights');
  check([device.get(dB),device.get(dLeaf)],[[],['view','security.events']],'boundary: a direct device role outside the boundary gives nothing');
  check([team.get(dB),team.get(dSib)],[access.allPermissions,[]],'boundary: customer through an enabled user group; the disabled group gives no customer');
  check((await access.effectivePermissions(pOwner,[dB])).get(dB),access.allPermissions,'boundary: a global Owner crosses every customer');
 }

 // ---- One statement, whatever the input size --------------------------
 prepares=0;check((await access.effectivePermissions(pGroups,[dLeaf])).size,1,'one id');check(prepares,1,'one prepare for one id');
 prepares=0;check((await access.effectivePermissions(pGroups,ids)).size,devices.length+1,'all ids');check(prepares,1,'one prepare for every fixture id');
 prepares=0;const empty=await access.effectivePermissions(pGroups,[]);check([empty instanceof Map,empty.size,prepares],[true,0,0],'empty input: empty Map, no query');
 const accessSource=fs.readFileSync('lib/server/identity/access.ts','utf8'),body=accessSource.slice(accessSource.indexOf('export async function effectivePermissions'));
 check(/jsonb_array_elements_text\(\$\{JSON\.stringify\(ids\)\}::jsonb\)/.test(body.slice(0,body.indexOf('\nexport '))),true,'the ids are one JSON parameter');

 // ---- Console route --------------------------------------------------
 await nextDatabase();
 const cRoot=await group(uuid(),'Konsole',null,customerA),cChild=await group(uuid(),'Konsole Kind',cRoot,customerA);
 const fleet=[];for(let i=0;i<60;i++)fleet.push(await device(uuid(),'Gerät '+String(i).padStart(2,'0'),customerA,cChild));
 const cRead=await role('Konsole','["view","security.events","runbooks.read","diagnose"]'),cView=await role('Ohne Security','["view","diagnose"]');
 const small=await persona('small'),big=await persona('big'),viewOnly=await persona('no-security'),both=await persona('both');
 for(const id of fleet.slice(0,3))await grant('user',small.id,cRead,'device',id);
 for(const id of fleet)await grant('user',big.id,cRead,'device',id);
 for(const id of fleet.slice(0,3))await grant('user',viewOnly.id,cView,'device',id);
 await grant('user',both.id,cView,'device',fleet[0]);await grant('user',both.id,cRead,'device',fleet[1]);
 const securityJob=uuid(),plainJob=uuid();
 await insert('jobs',{id:securityJob,server_id:fleet[0],action:'refresh',target:'',parameters:'{}',state:'pending',created_at:time,actor:'fixture',actor_email:'fixture',actor_principal:'private:fixture'});
 await insert('jobs',{id:plainJob,server_id:fleet[1],action:'refresh',target:'',parameters:'{}',state:'pending',created_at:time-1,actor:'fixture',actor_email:'fixture',actor_principal:'private:fixture'});
 await insert('job_outputs',{job_id:securityJob,server_id:fleet[0],data:JSON.stringify({scope:{security:1}}),created_at:time});
 for(const id of fleet.slice(0,2))for(let i=0;i<3;i++)await insert('audit',{at:time+i,actor:'fixture',action:'Fixture',target:'Audit',server_id:id,scope:'device'});
 const get=async(p,query='')=>{viewer=p;const response=await consoleApi.GET(new Request('https://batched.test/api/console'+query));check(response.status,200,'console GET '+p.label+query);return response.json();};
 const counted=async(p,query)=>{prepares=0;await get(p,query);return prepares;};
 {
  const body=await get(small);
  check(body.servers.map(row=>row.id).sort(),fleet.slice(0,3).sort(),'console: the visible servers');
  for(const row of body.servers)check(row.permissions,await access.permissionsFor(small,row.id),'console: servers[].permissions as permissionsFor');
  check(body.servers.every(row=>row.snapshot===null),true,'console: snapshots still pass through snapshotForPermissions');
  check([...new Set(body.deviceAudit.map(row=>row.serverId))].sort(),fleet.slice(0,2).sort(),'console: view and security.events show the device audit');
  check(body.jobs.map(job=>job.id),[securityJob,plainJob],'console: both jobs with security.events');
  check((await get(small,'?jobsOnly=1')).jobs.map(job=>job.id),[securityJob,plainJob],'jobsOnly: a security output is listed with security.events');
  check((await get(viewOnly,'?jobsOnly=1')).jobs.map(job=>job.id),[plainJob],'jobsOnly: a security output is hidden without security.events');
  const view=await get(viewOnly);
  check([view.deviceAudit,view.jobs.map(job=>job.id)],[[],[plainJob]],'console: without security.events no device audit and no security output');
  for(const row of view.servers)check(row.permissions,['view','diagnose'],'console: permissions without security.events');
  const mixed=await get(both);
  check([...new Set(mixed.deviceAudit.map(row=>row.serverId))],[fleet[1]],'console: the audit shows only devices with both rights');
 }
 check([await counted(small,''),await counted(small,'?jobsOnly=1')],[await counted(big,''),await counted(big,'?jobsOnly=1')],'console: the same prepare count for 3 and for 60 visible devices');
 // The statements of the timed section of the time budget below, on 3 and on 60 visible devices.
 const sectionStatements=async p=>{const visible=await access.allowedDeviceIds(p);prepares=0;await rightsAndAudit(p,visible);return prepares;};
 const consoleStatements=await sectionStatements(big);
 check([consoleStatements,await sectionStatements(small)],[2,2],'rights and device audit: two statements for 3 and for 60 visible devices');
 check(fs.readFileSync('app/api/console/route.ts','utf8').includes('permissionsFor('),false,'the console route no longer calls permissionsFor');
 // Rights revoked after the id list was built: the audit query checks them again.
 auditHook=()=>current.exec(sql`DELETE FROM role_assignments WHERE principal_id=${small.id} AND scope_id=${fleet[0]}`);
 const live=await get(small);
 check([auditHook,[...new Set(live.deviceAudit.map(row=>row.serverId))]],[null,[fleet[1]]],'console: a revocation after the pre-filter is checked live in the audit query');
 const guard=auditScope.deviceAuditGuard(small,[fleet[0],fleet[1]]);
 check(/a\.server_id IN \(SELECT audit_target\.value FROM jsonb_array_elements_text\(\$\d+::jsonb\) audit_target/.test(compile(guard).text),true,'the rights subquery reads the ids, not the audit row');

 // ---- Time budget on a synthetic fleet ------------------------------------
 await nextDatabase();
 const seedStart=performance.now(),groupId=k=>`10000000-0000-4000-8000-${String(k).padStart(12,'0')}`,depthTwo=[];
 // Five root trees with branching 3, filled breadth-first to 100 groups each (depth 0-4).
 for(let tree=0,k=0;tree<5;tree++){
  const queue=[{id:groupId(k++),parent:null,depth:0}];let made=0;
  while(queue.length&&made<100){const node=queue.shift();await group(node.id,'Flotte '+node.id.slice(-4),node.parent,customerA);made++;if(node.depth===2)depthTwo.push(node.id);if(node.depth<4)for(let c=0;c<3;c++)queue.push({id:groupId(k++),parent:node.id,depth:node.depth+1});}
  k=(tree+1)*100;
 }
 check(await current.one(sql`SELECT count(*) AS n FROM device_groups`).then(row=>row===null?null:row.n),500,'fleet: 500 groups');
 check(await current.one(sql`SELECT max(depth) AS n FROM device_group_ancestors`).then(row=>row===null?null:row.n),4,'fleet: depth 4');
 // Generated ids: the counter i padded to the last uuid group.
 const deviceId=sql`'20000000-0000-4000-8000-'||lpad(i::text,12,'0')`,fleetGroup=sql`'10000000-0000-4000-8000-'||lpad((i%500)::text,12,'0')`;
 await current.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,management,customer_id) SELECT ${deviceId},'Flotte '||i,'fixture-'||i,${time},${time},1,${customerA} FROM generate_series(0,4999) AS i`);
 // Device i joins group i%500, renumbered onto the ids above (k runs 0-99 per tree).
 await current.exec(sql`INSERT INTO device_group_members(server_id,group_id) SELECT ${deviceId},${fleetGroup} FROM generate_series(0,4999) AS i WHERE EXISTS (SELECT 1 FROM device_groups WHERE id=${fleetGroup})`);
 check(await current.one(sql`SELECT count(*) AS n FROM device_group_members`).then(row=>row===null?null:row.n),5000,'fleet: every device in one group');
 await current.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) SELECT ${time}::bigint+i,'fixture','Fixture','Audit','20000000-0000-4000-8000-'||lpad((i%5000)::text,12,'0'),'device' FROM generate_series(0,49999) AS i`);
 const fRead=await role('Flotte lesen','["view","security.events"]'),fView=await role('Flotte ansehen','["view"]'),fScoped=await role('Flotte bereich','["view","security.events","runbooks","diagnose"]');
 const globalReader=await persona('fleet-global'),globalViewer=await persona('fleet-view'),scopedUser=await persona('fleet-scoped');
 await grant('user',globalReader.id,fRead,'global');await grant('user',globalViewer.id,fView,'global');
 for(const id of depthTwo.filter((_,i)=>i%4===0).slice(0,6))await grant('user',scopedUser.id,fScoped,'devicegroup',id);
 await current.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) SELECT 'fleet-'||i,'user',${scopedUser.id}::text,${fRead}::text,'device','20000000-0000-4000-8000-'||lpad(((i*16+7)%5000)::text,12,'0'),${time}::bigint,'fixture' FROM generate_series(0,299) AS i`);
 // A live database has planner statistics (autovacuum analyzes tables after bulk writes); the seeded fixture gets them right away.
 await current.exec(sql`ANALYZE`);
 console.log(`fleet seeded in ${Math.round(performance.now()-seedStart)} ms`);
 const spot=random(4545);
 for(const [name,p] of [['global view+security.events',globalReader],['global view',globalViewer],['scoped',scopedUser]]){
  let start=performance.now();const visible=await access.allowedDeviceIds(p);const allowed=performance.now()-start;
  // Deterministic part: a fixed number of statements, whatever the fleet size.
  prepares=0;const {permissionMap,auditDevices,rows}=await rightsAndAudit(p,visible);
  check(prepares,consoleStatements,`${name}: rights and device audit run the same ${consoleStatements} statements as on the 60-device console fixture`);
  // Wall time: the fastest of five runs against 1,000 ms times the load factor of this database.
  const timed=await budgeted(current,1000,()=>rightsAndAudit(p,visible));
  start=performance.now();const all=auditScope.deviceAuditGuard(p,visible);await current.query(sql`${auditScope.auditSelect} WHERE ${all} ORDER BY a.at DESC,a.id DESC LIMIT 200`);const unfiltered=performance.now()-start;
  console.log(`${name}: ${visible.length} visible, ${auditDevices.length} with audit, ${rows.length} audit rows; rights+audit ${budgetText(timed)}, allowedDeviceIds ${Math.round(allowed)} ms (no budget), audit guard over all visible ${Math.round(unfiltered)} ms (no budget)`);
  check(timed.ms<timed.budget,true,`${name}: rights and device audit within the budget (${budgetText(timed)})`);
  check(rows.length,name==='global view'?0:200,`${name}: device audit rows`);
  for(let i=0;i<50;i++){const id=visible[Math.floor(spot()*visible.length)];check(permissionMap.get(id),await access.permissionsFor(p,id),`${name}: spot check ${id}`);}
 }
 console.log(`PASS: ${checks} batched permission assertions: effectivePermissions equals permissionsFor (fixed and seeded personas, with and without the boundary), one statement, the console map and live device audit, the statement count and the load-scaled time budget.`);
}finally{for(const database of databases)await database.close();}
