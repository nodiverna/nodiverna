// MSP library and customer catalogs for runbooks, automation templates
// and roles, against the real libraries and routes on an isolated PostgreSQL test database.
// Customer A is the first customer. While it is the only one, every entry is
// library and a non-Owner writes the library. Customers B and C are created by
// SQL later: from then on only an Owner writes the library, and a library
// runbook over A and B passes the cross-customer gate.
import {serverText} from '../support/server-text.mjs';
// The body keeps the codes a client branches on; the generic codes per status are checked in tests/repo/error-codes.mjs.
import {HttpError as realHttpError,genericCode} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const time=Date.now(),uuid=()=>crypto.randomUUID(),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
 const customerA='00000000-0000-4000-8000-000000000100',customerB=uuid(),customerC=uuid();
 const HttpError=realHttpError;
 // The batch hook runs once, right before the next batch: the committing write.
 let viewer=null,beforeBatch=null;
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}}});
 const server={db:()=>facade,now:()=>Date.now(),config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>hash(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
  body:request=>request.json(),sameOrigin:()=>{},requireViewer:async()=>viewer,
  log:async(actor,action,target,serverId)=>{const ids=serverId===undefined?[null]:[...new Set(Array.isArray(serverId)?serverId:[serverId])];for(const id of ids)await d.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${Date.now()},${actor},${action},${target},${id},${id?'device':'portal'})`);},
  failure:error=>Response.json({error:error instanceof HttpError?error.message:serverText('apiError.storageUnavailable'),...(error instanceof HttpError&&error.code&&!genericCode(error.code)?{code:error.code}:{})},{status:error instanceof HttpError?error.status:503})};
 // Routine writes (lib/step-up.ts) commit behind the live-session fence.
 const mfa={requireLiveSessions:async()=>{},mfaSessionFence:async(request,actor)=>localAuth.primaryGuard(request,actor),requireMfa:async()=>{},isMfaEnabled:async()=>true,readMfaManagementProof:async(_request,actor,token)=>({tokenHash:token,key:actor.principal,sessionHash:hash(actor.id+'mfa'),guard:sql`TRUE`})};
 const localAuth={primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor)};
 const v3={maintenanceBusy:async()=>false,modern:device=>JSON.parse(device.snapshot||'{}'),windowsPath:path=>String(path),CHUNK_SIZE:262144,MAX_TRANSFER:1<<30,securityFile:()=>false,bucket:()=>({})};
 const management={operations:{refresh:{readOnly:true,label:'Aktualisieren',schema:{safeParse:value=>({success:true,data:value})}}},safeTarget:()=>''};
 const agentCrypto={sealAgentSecrets:async()=>({})};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./local-auth':localAuth,'./mfa':mfa,'../identity/mfa':mfa,'@/lib/server/identity/mfa':mfa,'../agent/agent-protocol':v3,'@/lib/server/agent/agent-protocol':v3,'../../management':management,'./management':management,'@/lib/management':management,'../agent/agent-crypto':agentCrypto,'@/lib/server/agent/agent-crypto':agentCrypto,
  '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
  '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},
  '@/lib/diagnostics':{diagnosticDefinitions:{},diagnosticSecurityAccess:()=>false,isDiagnosticKind:()=>false},'@/lib/file-operations':{fileSecurityAccess:()=>false},
  '@/lib/server/devices/device-lifecycle':{removeDevice:async()=>({}),removeDevices:async()=>({}),sweepRemovedTransfers:async()=>{}},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
 const load=sourceLoader();
 const access=load('lib/server/identity/access.ts',imports),ownership=load('lib/server/catalog-ownership.ts',imports);
 const runbooks=load('lib/server/automation/runbooks.ts',imports),scopes=load('lib/server/automation/automation-scopes.ts',imports),rbac=load('lib/server/identity/rbac.ts',imports);
 const runbooksApi=load('app/api/runbooks/route.ts',imports),automationApi=load('app/api/automation/route.ts',imports),rbacApi=load('app/api/rbac/route.ts',imports),accessApi=load('app/api/access/route.ts',imports),consoleApi=load('app/api/console/route.ts',imports);

 // ---- Fixture ----------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const gA=uuid(),gB=uuid();
 await insert('device_groups',{id:gA,name:'Gruppe A',description:'',created_at:time,parent_id:null,customer_id:customerA});
 const snapshot=JSON.stringify({protocolVersion:3,agentCapabilities:['runbook-step','refresh'],mode:'Management',os:'Windows Server 2022'});
 const dA=uuid(),dA2=uuid(),dB=uuid();
 for(const [id,name] of [[dA,'Server A'],[dA2,'Server A2']])await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,snapshot,customer_id:customerA});
 await insert('device_group_members',{server_id:dA,group_id:gA});
 // Customers B and C with their group and device: the second customer switches the separation on.
 const separate=async()=>{
  await insert('customers',{id:customerB,name:'Kunde B',created_at:time,updated_at:time});
  await insert('customers',{id:customerC,name:'Kunde C',created_at:time,updated_at:time});
  await insert('device_groups',{id:gB,name:'Gruppe B',description:'',created_at:time,parent_id:null,customer_id:customerB});
  await insert('servers',{id:dB,name:'Server B',token_hash:'fixture-'+dB,created_at:time,last_seen:time,management:1,snapshot,customer_id:customerB});
  await insert('device_group_members',{server_id:dB,group_id:gB});
 };
 const actor=async(label,permissions)=>{const created=(await sourceActor(d,label,permissions)).actor;created.userId=created.id;
  await insert('mfa_sessions',{token_hash:hash(created.id+'mfa'),principal:created.principal,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
  await insert('mfa_accounts',{principal:created.principal,secret_enc:'fixture',recovery_hashes:'[]',last_counter:0,created_at:time-60_000});return created;};
 const owner=await actor('owner@catalog.test',['*']);
 const techA=await actor('techa@catalog.test',[...access.allPermissions]);
 const techB=await actor('techb@catalog.test',[...access.allPermissions]);
 const rolesA=await actor('roles-a@catalog.test',['portal.roles.manage']);
 const rolesB=await actor('roles-b@catalog.test',['portal.roles.manage','portal.roleAssignments.manage']);
 const uaa=await actor('uaa@catalog.test',['portal.roleAssignments.manage']);
 const ownerAssignment=await d.one(sql`SELECT a.* FROM role_assignments a WHERE a.principal_id=${owner.id} AND a.scope_type='global'`);
 const assign=(customer,id)=>insert('customer_assignments',{customer_id:customer,principal_type:'user',principal_id:id,created_at:time,created_by:owner.principal});
 const unassign=(customer,id)=>d.exec(sql`DELETE FROM customer_assignments WHERE customer_id=${customer} AND principal_type='user' AND principal_id=${id}`);
 const proof=async who=>{const token=uuid();await insert('mfa_management_proofs',{token_hash:token,principal:who.principal,session_hash:hash(who.id+'mfa'),expires_at:Date.now()+300_000});return token;};
 const manage=async(who,payload)=>{viewer=who;return rbac.manageRbac(who,payload,await rbac.prepareManagementAuthorization(new Request('https://catalog.test/api/rbac'),who,await proof(who)));};
 const post=async(api,who,payload)=>{viewer=who;return api.POST(new Request('https://catalog.test/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,managementToken:await proof(who)})}));};
 const get=async(api,who,query='')=>{viewer=who;return api.GET(new Request('https://catalog.test/api'+query));};
 const answer=async response=>({status:response.status,body:await response.json()});
 const rejects=async(promise,status,message,label)=>{await assert.rejects(promise,error=>{assert.equal(error.status,status,label+': '+error.message);if(message)assert.equal(error.message,message,label);return true;},label);checks++;};
 const count=async statement=>Number((await d.one(statement)).n);
 const customerOf=(table,id)=>d.one(sql`SELECT customer_id FROM ${sql.ident(table)} WHERE id=${id}`).then(row=>row===null?null:row.customer_id);
 const audits=()=>count(sql`SELECT count(*) AS n FROM audit`);
 const definition={steps:[{id:'refresh',name:'Aktualisieren',kind:'diagnosis',operation:'refresh'}],parameters:[]};
 const createRunbook=async(who,name,customerId)=>runbooks.createRunbookVersion(who,{name,description:'',definition,...(customerId===undefined?{}:{customerId})});
 const desiredConfig=uuid(),desiredVersion=uuid();
 await insert('desired_configs',{id:desiredConfig,name:'Baseline',description:'',created_by:owner.principal,created_at:time});
 await insert('desired_versions',{id:desiredVersion,config_id:desiredConfig,version:1,engine:'dsc3',content:'{}',sha256:'0'.repeat(64),created_by:owner.principal,created_at:time});
 await insert('drift_policies',{server_id:dA,id:uuid(),version:1,enabled:1,policy:JSON.stringify({enabled:true,config:['services']}),created_at:time,updated_at:time,updated_by:owner.principal});
 const messages={
  libraryOwnerOnly:serverText('apiError.catalog.libraryOwnerOnly'),
  unavailable:serverText('apiError.customer.unavailable'),
  disabled:serverText('apiError.catalog.customerDisabled'),
  immutable:serverText('apiError.customer.catalogOwnerImmutable'),
  runbookTargets:serverText('apiError.catalog.runbookCustomerTargets'),
  templateRunbook:serverText('apiError.catalog.templateRunbookCustomer'),
  templateScope:serverText('apiError.customer.templateScope'),
  drift:serverText('apiError.catalog.driftTemplateCustomer'),
  rolePermissions:serverText('apiError.customer.rolePermissions'),
  roleScope:serverText('apiError.customer.roleScope'),
  runPartial:serverText('apiError.catalog.runCancelPartial'),
  schedulePartial:serverText('apiError.catalog.scheduleCancelPartial'),
  assignmentMissing:serverText('apiError.catalog.assignmentGone'),
 };
 for(const [name,text] of Object.entries({libraryOwnerOnlyMessage:messages.libraryOwnerOnly,customerUnavailableMessage:messages.unavailable,catalogCustomerDisabledMessage:messages.disabled,catalogOwnerImmutableMessage:messages.immutable,runbookCustomerTargetsMessage:messages.runbookTargets,templateRunbookCustomerMessage:messages.templateRunbook,templateScopeCustomerMessage:messages.templateScope,driftTemplateCustomerMessage:messages.drift,customerRolePermissionsMessage:messages.rolePermissions,customerRoleScopeMessage:messages.roleScope,runCancelPartialMessage:messages.runPartial,scheduleCancelPartialMessage:messages.schedulePartial,assignmentMissingMessage:messages.assignmentMissing}))check(ownership[name],text,'UI copy '+name);

 // ---- While only the default customer exists everything is library ------------------
 const preBook=await createRunbook(techA,'Vorher');
 const preTemplate=await scopes.createAutomationTemplate(techA,{kind:'desired',name:'Vorher',versionId:desiredVersion});
 const preRole=await manage(rolesA,{action:'create-role',name:'Vorher',permissions:['view']});
 check([await customerOf('runbooks',preBook.id),await customerOf('automation_templates',preTemplate.id),await customerOf('rbac_roles',preRole.id)],[null,null,null],'one customer: new entries are library');
 check((await runbooks.listRunbooks(techB)).runbooks.some(row=>row.id===preBook.id),true,'one customer: techB sees the runbook');
 check((await scopes.listAutomationScopes(techB)).templates.some(row=>row.id===preTemplate.id),true,'one customer: techB sees the template');
 {
  const listed=await runbooks.listRunbooks(techA);check(listed.catalog.separated,false,'one customer: catalog.separated=false');
  check(listed.runbooks.find(row=>row.id===preBook.id).customerId,null,'one customer: customerId null');
  check(listed.runbooks.find(row=>row.id===preBook.id).customerName,null,'one customer: customerName null');
  for(const [api,who] of [[runbooksApi,techA],[automationApi,techA],[rbacApi,rolesA]]){const {status,body}=await answer(await get(api,who));check([status,body.catalog?.separated,body.catalog?.libraryWritable],[200,false,true],'one customer: GET carries catalog');}
 }

 // ---- A second customer: the catalogs are separated ----------------------------------
 await separate();
 for(const who of [techA,rolesA,uaa])await assign(customerA,who.id);
 for(const who of [techB,rolesB])await assign(customerB,who.id);
 await assign(customerC,techA.id);await d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${customerC}`);

 // ---- A library runbook over A and B passes the cross-customer gate ----------------
 {
  const mixed=await runbooks.startRun(owner,{versionId:preBook.versionId,targets:[dA,dB],confirm:true});
  check(typeof mixed.id,'string','the Owner starts the library runbook over A and B');
  check(await count(sql`SELECT count(*) AS n FROM runbook_run_devices WHERE run_id=${mixed.id}`),2,'the run has both targets');
  await rejects(runbooks.startRun(techA,{versionId:preBook.versionId,targets:[dA,dB],confirm:true}),404,null,'techA does not see B: the boundary answers first');
 }

 // ---- Owner and write rule ---------------------------------------------------
 const bookA=await createRunbook(techA,'Runbook A',customerA);
 const templateA=await scopes.createAutomationTemplate(techA,{kind:'desired',name:'Desired A',versionId:desiredVersion,customerId:customerA});
 const runbookTemplateA=await scopes.createAutomationTemplate(techA,{kind:'runbook',name:'Runbook-Vorlage A',versionId:bookA.versionId,customerId:customerA});
 const roleA=await manage(rolesA,{action:'create-role',name:'Rolle A',permissions:['view','terminal'],customerId:customerA});
 check([await customerOf('runbooks',bookA.id),await customerOf('automation_templates',templateA.id),await customerOf('automation_templates',runbookTemplateA.id),await customerOf('rbac_roles',roleA.id)],[customerA,customerA,customerA,customerA],'entries of A are stored with A');
 {
  const rows=async()=>[await count(sql`SELECT count(*) AS n FROM runbooks`),await count(sql`SELECT count(*) AS n FROM automation_templates`),await count(sql`SELECT count(*) AS n FROM rbac_roles`)];
  const before=await rows();
  await rejects(createRunbook(techA,'Bibliothek'),403,messages.libraryOwnerOnly,'techA: runbook without customerId');
  await rejects(scopes.createAutomationTemplate(techA,{kind:'desired',name:'Bibliothek',versionId:desiredVersion}),403,messages.libraryOwnerOnly,'techA: template without customerId');
  await rejects(manage(rolesA,{action:'create-role',name:'Bibliothek',permissions:['view']}),403,messages.libraryOwnerOnly,'rolesA: role without customerId');
  await rejects(createRunbook(techA,'Fremd',customerB),404,messages.unavailable,'customerId of B');
  await rejects(createRunbook(techA,'Unbekannt',uuid()),404,messages.unavailable,'unknown customer');
  await rejects(createRunbook(techA,'Deaktiviert',customerC),409,messages.disabled,'disabled customer C');
  await rejects(createRunbook(techA,'Kaputt','kunde-a'),400,serverText('apiError.customer.invalid'),'customerId is no GUID');
  await rejects(manage(rolesA,{action:'create-role',name:'Fremd',permissions:['view'],customerId:customerB}),404,messages.unavailable,'role for B');
  check(await rows(),before,'no rows for the refused requests');
  const library=await createRunbook(owner,'Bibliothek Owner'),ownerB=await createRunbook(owner,'Owner für B',customerB);
  check([await customerOf('runbooks',library.id),await customerOf('runbooks',ownerB.id)],[null,customerB],'the Owner writes the library and every customer');
  await runbooks.deleteRunbook(owner,{confirm:true,runbookId:ownerB.id});
  // Races: the customer assignment or the Owner role goes away before the commit.
  beforeBatch=()=>unassign(customerA,techA.id);
  await rejects(createRunbook(techA,'Rennen A',customerA),404,messages.unavailable,'race: A assignment removed');
  await assign(customerA,techA.id);
  beforeBatch=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${ownerAssignment.id}`);
  await rejects(createRunbook(owner,'Rennen Owner'),403,messages.libraryOwnerOnly,'race: Owner role removed');
  await insert('role_assignments',{...ownerAssignment});
  beforeBatch=()=>unassign(customerA,rolesA.id);
  await rejects(manage(rolesA,{action:'create-role',name:'Rennen Rolle',permissions:['view'],customerId:customerA}),404,messages.unavailable,'race: rolesA loses A');
  await assign(customerA,rolesA.id);
  check(await count(sql`SELECT count(*) AS n FROM runbooks WHERE name IN ('Rennen A','Rennen Owner')`)+await count(sql`SELECT count(*) AS n FROM rbac_roles WHERE name='Rennen Rolle'`),0,'races: nothing written');
  // The customer is disabled between the pre-check and the commit.
  beforeBatch=()=>d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${customerB}`);
  await rejects(createRunbook(owner,'Rennen deaktiviert',customerB),409,messages.disabled,'race: customer disabled, 409 and not 503');
  await d.exec(sql`UPDATE customers SET status='active' WHERE id=${customerB}`);
  check(await count(sql`SELECT count(*) AS n FROM runbooks WHERE name='Rennen deaktiviert'`),0,'race: no runbook for the disabled customer');
  // catalog
  check((await runbooks.listRunbooks(techA)).catalog,{separated:true,libraryWritable:false,customers:[{id:customerA,name:'Standardkunde'}]},'catalog for techA');
  check((await runbooks.listRunbooks(owner)).catalog,{separated:true,libraryWritable:true,customers:[{id:customerB,name:'Kunde B'},{id:customerA,name:'Standardkunde'}]},'catalog for the Owner: every active customer');
  // The owner of an existing entry does not change.
  await rejects(runbooks.createRunbookVersion(techA,{runbookId:bookA.id,name:'Runbook A',description:'',definition,customerId:customerB}),400,messages.immutable,'new version with another customerId');
  await rejects(runbooks.createRunbookVersion(techA,{runbookId:bookA.id,name:'Runbook A',description:'',definition,customerId:null}),400,messages.immutable,'new version moving to the library');
  await rejects(manage(rolesA,{action:'update-role',id:roleA.id,name:'Rolle A',permissions:['view'],customerId:null}),400,messages.immutable,'role update moving to the library');
  check((await runbooks.createRunbookVersion(techA,{runbookId:bookA.id,name:'Runbook A',description:'',definition,customerId:customerA})).id,bookA.id,'the same customerId is accepted');
 }

 // ---- Runbooks -----------------------------------------------------------------
 {
  const listB=await runbooks.listRunbooks(techB),text=JSON.stringify(listB);
  check([text.includes(bookA.id),text.includes(bookA.versionId)],[false,false],'listRunbooks(techB): nothing of the A runbook');
  check(listB.runbooks.find(row=>row.id===preBook.id)?.customerName,null,'techB sees the library runbook');
  const listA=await runbooks.listRunbooks(techA),rowA=listA.runbooks.find(row=>row.id===bookA.id);
  check([rowA?.customerId,rowA?.customerName,listA.runbooks.some(row=>row.id===preBook.id)],[customerA,'Standardkunde',true],'techA sees A and the library');
  check(listA.runbooks.find(row=>row.id===preBook.id).canManage,false,'the library runbook is not manageable for techA');
  check((await runbooks.listRunbooks(owner)).runbooks.find(row=>row.id===bookA.id)?.customerName,'Standardkunde','the Owner sees A');
  // previewRun, startRun, createSchedule with a version of A answer like an unknown one.
  const runs=await count(sql`SELECT count(*) AS n FROM runbook_runs`),schedules=await count(sql`SELECT count(*) AS n FROM runbook_schedules`);
  for(const action of ['dryrun','run','schedule']){
   const payload={action,targets:[dB],confirm:true,recurrence:{kind:'interval',minutes:60}};
   const foreign=await answer(await post(runbooksApi,techB,{...payload,versionId:bookA.versionId})),unknown=await answer(await post(runbooksApi,techB,{...payload,versionId:uuid()}));
   check(foreign,unknown,action+': a version of A equals an unknown version');check(foreign,{status:404,body:{error:serverText('apiError.runbook.versionNotFound')}},action+': 404');
  }
  check([await count(sql`SELECT count(*) AS n FROM runbook_runs`),await count(sql`SELECT count(*) AS n FROM runbook_schedules`)],[runs,schedules],'no run and no schedule');
  await rejects(runbooks.startRun(owner,{versionId:bookA.versionId,targets:[dB],confirm:true}),400,messages.runbookTargets,'the A runbook on dB');
  await rejects(runbooks.createSchedule(owner,{versionId:bookA.versionId,targets:[dA,dB],confirm:true,recurrence:{kind:'interval',minutes:60}}),400,messages.runbookTargets,'scheduling the A runbook on dB');
  await rejects(runbooks.previewRun(owner,{versionId:bookA.versionId,targets:[dB]}),400,messages.runbookTargets,'previewing the A runbook on dB');
  check(await count(sql`SELECT count(*) AS n FROM runbook_runs`),runs,'no run on dB');
  // Race: the pre-check sees dA2 in A; before the commit it belongs to B.
  beforeBatch=()=>d.exec(sql`UPDATE servers SET customer_id=${customerB} WHERE id=${dA2}`);
  await rejects(runbooks.startRun(owner,{versionId:bookA.versionId,targets:[dA2],confirm:true}),404,serverText('apiError.runbook.targetRemoved'),'race: target moved to B');
  check(await count(sql`SELECT count(*) AS n FROM runbook_runs`),runs,'race: no run');
  await d.exec(sql`UPDATE servers SET customer_id=${customerA} WHERE id=${dA2}`);
  const started=await runbooks.startRun(techA,{versionId:bookA.versionId,targets:[dA],confirm:true});check(typeof started.id,'string','control: techA runs the A runbook on dA');
  const library=await runbooks.startRun(techB,{versionId:preBook.versionId,targets:[dB],confirm:true});check(typeof library.id,'string','control: library runbooks run on B');
  // Versions and deletion of a foreign runbook answer like a missing one.
  await rejects(runbooks.createRunbookVersion(techB,{runbookId:bookA.id,name:'Neu',description:'',definition}),404,serverText('apiError.runbook.notFound'),'new version of A by techB');
  await rejects(runbooks.createRunbookVersion(techB,{runbookId:uuid(),name:'Neu',description:'',definition}),404,serverText('apiError.runbook.notFound'),'new version of an unknown runbook');
  await rejects(runbooks.deleteRunbook(techB,{confirm:true,runbookId:bookA.id}),404,serverText('apiError.runbook.notFound'),'deleting A by techB');
  // The library after the separation: its creator techA no longer changes it, the Owner does.
  await rejects(runbooks.createRunbookVersion(techA,{runbookId:preBook.id,name:'Vorher',description:'',definition}),403,messages.libraryOwnerOnly,'techA versions the library runbook');
  await rejects(runbooks.deleteRunbook(techA,{confirm:true,runbookId:preBook.id}),403,messages.libraryOwnerOnly,'techA deletes the library runbook');
  check(await d.one(sql`SELECT archived FROM runbooks WHERE id=${preBook.id}`).then(row=>row===null?null:row.archived),0,'the library runbook stays');
  check((await runbooks.createRunbookVersion(owner,{runbookId:preBook.id,name:'Vorher',description:'',definition})).id,preBook.id,'the Owner versions the library runbook');
 }

 // ---- Automation templates --------------------------------------------------------
 {
  check((await scopes.listAutomationScopes(techB)).templates.some(row=>row.id===templateA.id||row.id===runbookTemplateA.id),false,'listAutomationScopes(techB): no template of A');
  const listed=await scopes.listAutomationScopes(techA),rowA=listed.templates.find(row=>row.id===templateA.id);
  check([rowA?.customerId,rowA?.customerName,listed.groups.find(row=>row.id===gA)?.customerId],[customerA,'Standardkunde',customerA],'templates and groups carry their customer');
  check(listed.catalog.separated,true,'listAutomationScopes carries the catalog');
  const assignments=await count(sql`SELECT count(*) AS n FROM automation_scope_assignments`);
  await rejects(scopes.assignAutomationScope(techB,{templateId:templateA.id,scopeType:'group',scopeId:gB,confirm:true}),404,serverText('apiError.automation.templateGone'),'assigning a template of A by techB');
  await rejects(scopes.assignAutomationScope(techB,{templateId:uuid(),scopeType:'group',scopeId:gB,confirm:true}),404,serverText('apiError.automation.templateGone'),'assigning an unknown template');
  await rejects(scopes.assignAutomationScope(owner,{templateId:templateA.id,scopeType:'group',scopeId:gB,confirm:true}),400,messages.templateScope,'the Owner assigns A to gB');
  await rejects(scopes.assignAutomationScope(owner,{templateId:templateA.id,scopeType:'device',scopeId:dB,confirm:true}),400,messages.templateScope,'the Owner assigns A to dB');
  check(await count(sql`SELECT count(*) AS n FROM automation_scope_assignments`),assignments,'no assignment row');
  await rejects(scopes.createAutomationTemplate(owner,{kind:'runbook',name:'Bibliothek mit A',versionId:bookA.versionId}),400,messages.templateRunbook,'a library template with the A runbook');
  await rejects(scopes.createAutomationTemplate(owner,{kind:'runbook',name:'B mit A',versionId:bookA.versionId,customerId:customerB}),400,messages.templateRunbook,'a template of B with the A runbook');
  await rejects(scopes.createAutomationTemplate(techB,{kind:'runbook',name:'B mit A',versionId:bookA.versionId,customerId:customerB}),404,serverText('apiError.automation.runbookVersionUnavailable'),'techB with a version of A');
  const libraryForA=await scopes.createAutomationTemplate(techA,{kind:'runbook',name:'A mit Bibliothek',versionId:preBook.versionId,customerId:customerA});
  check(await customerOf('automation_templates',libraryForA.id),customerA,'a template of A may use a library runbook');
  // Drift: the owner is the reference device's customer.
  const drift=await scopes.createAutomationTemplate(owner,{kind:'drift',name:'Drift A',sourceServerId:dA,includeBaseline:false});
  check(await customerOf('automation_templates',drift.id),customerA,'a drift template of dA belongs to A, also for the Owner');
  await rejects(scopes.createAutomationTemplate(owner,{kind:'drift',name:'Drift B',sourceServerId:dA,includeBaseline:false,customerId:customerB}),400,messages.drift,'drift of dA with customerId B');
  await rejects(scopes.createAutomationTemplate(owner,{kind:'drift',name:'Drift Bibliothek',sourceServerId:dA,includeBaseline:false,customerId:null}),400,messages.drift,'drift of dA in the library');
  // The template of A works on dA and never on dB.
  const onGroup=await scopes.assignAutomationScope(techA,{templateId:templateA.id,scopeType:'group',scopeId:gA,confirm:true});
  check((await scopes.effectiveAutomationForDevice(dA,'desired')).map(row=>row.templateId),[templateA.id],'the template of A applies on dA');
  check((await scopes.effectiveAutomationForDevice(dB,'desired')).length,0,'nothing on dB');
  await assert.rejects(d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,disabled,actor,auth_version,created_at) VALUES(${uuid()},${'desired'},${'default'},${'device'},${dB},${templateA.id},0,${owner.principal},1,${time})`),/customer-catalog-mismatch/);checks++;
  await d.exec(sql`DELETE FROM device_group_members WHERE server_id=${dA}`);
  await assert.rejects(d.exec(sql`UPDATE device_groups SET customer_id=${customerB} WHERE id=${gA}`),/customer-mismatch/);checks++;
  await insert('device_group_members',{server_id:dA,group_id:gA});
  check((await scopes.effectiveAutomationForDevice(dB,'desired')).length,0,'still nothing on dB');
  await scopes.removeAutomationScope(techA,{assignmentId:onGroup.id,confirm:true});checks++;
 }

 // ---- Roles ---------------------------------------------------------------------------
 {
  const dataB=await rbac.rbacData(rolesB);
  check([dataB.roles.some(row=>row.id===roleA.id),JSON.stringify(dataB).includes(roleA.id)],[false,false],'rbacData(rolesB): no role of A');
  const dataA=await rbac.rbacData(rolesA),rowA=dataA.roles.find(row=>row.id===roleA.id);
  check([rowA?.customerId,rowA?.customerName,dataA.roles.find(row=>row.id===preRole.id)?.customerId],[customerA,'Standardkunde',null],'roles carry their owner');
  check([dataA.deviceGroups.find(row=>row.id===gA)?.customerId,dataA.devices.find(row=>row.id===dA)?.customerId],[customerA,customerA],'groups and devices carry their customer');
  check(dataA.catalog,{separated:true,libraryWritable:false,customers:[{id:customerA,name:'Standardkunde'}]},'rbacData carries the catalog');
  const unknownRole=uuid();
  for(const [label,payload] of [['update-role',{action:'update-role',name:'Neu',permissions:['view']}],['delete-role',{action:'delete-role'}],['add-assignment',{action:'add-assignment',subjectType:'user',subjectId:techB.id,scopeType:'devicegroup',scopeId:gB}]]){
   const roleKey=label==='add-assignment'?'roleId':'id';
   await rejects(manage(rolesB,{...payload,[roleKey]:roleA.id}),404,serverText('apiError.rbac.roleNotFound'),label+' with the role of A by rolesB');
   await rejects(manage(rolesB,{...payload,[roleKey]:unknownRole}),404,serverText('apiError.rbac.roleNotFound'),label+' with an unknown role');
  }
  await rejects(manage(rolesA,{action:'create-role',name:'Portal A',permissions:['view','portal.operator'],customerId:customerA}),400,messages.rolePermissions,'a customer role with portal.operator');
  await rejects(manage(rolesA,{action:'update-role',id:roleA.id,name:'Rolle A',permissions:['view','portal.users.manage']}),400,messages.rolePermissions,'updating a customer role to a portal right');
  const assignments=await count(sql`SELECT count(*) AS n FROM role_assignments`);
  await rejects(manage(uaa,{action:'add-assignment',subjectType:'user',subjectId:techA.id,roleId:roleA.id,scopeType:'global',scopeId:'*'}),400,messages.roleScope,'the role of A globally');
  await rejects(manage(owner,{action:'add-assignment',subjectType:'user',subjectId:techA.id,roleId:roleA.id,scopeType:'devicegroup',scopeId:gB}),400,messages.roleScope,'the role of A on gB');
  await rejects(manage(owner,{action:'add-assignment',subjectType:'user',subjectId:techA.id,roleId:roleA.id,scopeType:'device',scopeId:dB}),400,messages.roleScope,'the role of A on dB');
  check(await count(sql`SELECT count(*) AS n FROM role_assignments`),assignments,'no assignment row');
  const recipient=await actor('recipient@catalog.test',[]);await assign(customerA,recipient.id);
  check(await access.permissionsFor(recipient,dA),[],'the recipient has no rights on dA yet');
  await manage(uaa,{action:'add-assignment',subjectType:'user',subjectId:recipient.id,roleId:roleA.id,scopeType:'devicegroup',scopeId:gA});
  check(await access.permissionsFor(recipient,dA),['view','terminal'],'the role of A on gA gives its rights on dA');
  // set-grant: the compatibility role belongs to the group's customer.
  const granted=await answer(await post(accessApi,owner,{action:'set-grant',groupId:gB,principal:techB.principal,role:'viewer',permissions:['view']}));
  check(granted.status,200,'set-grant on gB');
  check(await customerOf('rbac_roles','compat-grant:'+techB.id+':'+gB),customerB,'the compat role belongs to B');
  const again=await answer(await post(accessApi,owner,{action:'set-grant',groupId:gB,principal:techB.principal,role:'operator',permissions:['view','diagnose']}));
  check([again.status,await customerOf('rbac_roles','compat-grant:'+techB.id+':'+gB)],[200,customerB],'the ON CONFLICT path keeps the owner');
  // A disabled customer keeps its compatibility roles but takes no new one (409, not 503).
  await d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${customerB}`);
  const kept=await answer(await post(accessApi,owner,{action:'set-grant',groupId:gB,principal:techB.principal,role:'viewer',permissions:['view']}));
  const refused=await answer(await post(accessApi,owner,{action:'set-grant',groupId:gB,principal:rolesB.principal,role:'viewer',permissions:['view']}));
  await d.exec(sql`UPDATE customers SET status='active' WHERE id=${customerB}`);
  check([kept.status,refused.status,refused.body.error,await count(sql`SELECT count(*) AS n FROM rbac_roles WHERE id=${'compat-grant:'+rolesB.id+':'+gB}`)],[200,409,messages.disabled,0],'set-grant on a disabled customer: existing role updated, new role refused');
  await rejects(manage(rolesA,{action:'update-role',id:preRole.id,name:'Vorher',permissions:['view','diagnose']}),403,messages.libraryOwnerOnly,'rolesA changes a library role');
  await rejects(manage(rolesA,{action:'delete-role',id:preRole.id}),403,messages.libraryOwnerOnly,'rolesA deletes a library role');
  await manage(owner,{action:'update-role',id:preRole.id,name:'Vorher',permissions:['view','diagnose']});checks++;
  await manage(rolesA,{action:'update-role',id:roleA.id,name:'Rolle A neu',permissions:['view','terminal']});checks++;
 }

 // ---- Existence oracles closed ------------------------------------------------------
 {
  const bookB=await createRunbook(techB,'Runbook B',customerB);
  const runB=(await runbooks.startRun(techB,{versionId:bookB.versionId,targets:[dB],confirm:true})).id;
  const scheduleB=(await runbooks.createSchedule(techB,{versionId:bookB.versionId,targets:[dB],confirm:true,recurrence:{kind:'interval',minutes:60}})).id;
  const templateB=await scopes.createAutomationTemplate(techB,{kind:'runbook',name:'Runbook-Vorlage B',versionId:bookB.versionId,customerId:customerB});
  const assignmentB=(await scopes.assignAutomationScope(techB,{templateId:templateB.id,scopeType:'group',scopeId:gB,confirm:true})).id;
  const state=async()=>[await audits(),await d.one(sql`SELECT cancel_requested FROM runbook_runs WHERE id=${runB}`).then(row=>row===null?null:row.cancel_requested),await d.one(sql`SELECT enabled FROM runbook_schedules WHERE id=${scheduleB}`).then(row=>row===null?null:row.enabled),await count(sql`SELECT count(*) AS n FROM automation_scope_assignments WHERE id=${assignmentB}`),await count(sql`SELECT count(*) AS n FROM runbook_runs`)];
  const before=await state();
  for(const [label,api,payload,key,foreignId,expected] of [
   ['cancelRun',runbooksApi,{action:'cancel'},'runId',runB,{status:404,body:{error:serverText('apiError.runbook.runNotFound')}}],
   ['cancelSchedule',runbooksApi,{action:'cancel-schedule'},'scheduleId',scheduleB,{status:404,body:{error:serverText('apiError.runbook.scheduleNotFound')}}],
   ['removeAutomationScope',automationApi,{action:'remove-assignment',confirm:true},'assignmentId',assignmentB,{status:404,body:{error:messages.assignmentMissing}}],
   ['startAutomationRun',automationApi,{action:'run',confirm:true},'assignmentId',assignmentB,{status:404,body:{error:serverText('apiError.runbook.assignmentGone')}}],
  ]){
   const foreign=await answer(await post(api,techA,{...payload,[key]:foreignId})),unknown=await answer(await post(api,techA,{...payload,[key]:uuid()}));
   check(foreign,unknown,label+': an id of B equals an unknown id');check(foreign,expected,label+': status and body');
  }
  check(await state(),before,'no audit, no cancel, no disabled schedule, no removed assignment, no run');
  // A run over A and B is only partly visible to techA. It is written by SQL, so
  // its owner is a fixed principal.
  const mixed=uuid();await d.exec(sql`INSERT INTO runbook_runs(id,version_id,due_key,actor,parameters,concurrency,failure_stop,created_at,expires_at) VALUES(${mixed},${preBook.versionId},${'mixed-'+mixed},${owner.principal},'{}',1,0,${Date.now()},${Date.now()+86_400_000})`);
  for(const server of [dA,dB])await d.exec(sql`INSERT INTO runbook_run_devices(run_id,server_id,sealed_secrets) VALUES(${mixed},${server},'{}')`);
  // Schedules serve one customer, so a schedule over A and B exists only from older data or direct SQL.
  const mixedSchedule=uuid();await d.exec(sql`INSERT INTO runbook_schedules(id,version_id,actor,targets,parameters,recurrence,next_due,catchup_seconds,concurrency,failure_stop,approved_at,created_at) VALUES(${mixedSchedule},${preBook.versionId},${owner.principal},${JSON.stringify([dA,dB])},${'{}'},${'{"kind":"interval","minutes":60}'},${Date.now()+3_600_000},${300},${1},${1},${Date.now()},${Date.now()})`);
  const auditsBefore=await audits();
  check(await answer(await post(runbooksApi,techA,{action:'cancel',runId:mixed})),{status:403,body:{error:messages.runPartial}},'cancelRun: partly visible run');
  check(await answer(await post(runbooksApi,techA,{action:'cancel-schedule',scheduleId:mixedSchedule})),{status:403,body:{error:messages.schedulePartial}},'cancelSchedule: partly visible schedule');
  check([await d.one(sql`SELECT cancel_requested FROM runbook_runs WHERE id=${mixed}`).then(row=>row===null?null:row.cancel_requested),await d.one(sql`SELECT enabled FROM runbook_schedules WHERE id=${mixedSchedule}`).then(row=>row===null?null:row.enabled),await audits()],[0,1,auditsBefore],'partial: nothing written');
  // Controls with own ids work as before; the Owner is not bounded.
  const runA=(await runbooks.startRun(techA,{versionId:bookA.versionId,targets:[dA],confirm:true})).id;
  check((await answer(await post(runbooksApi,techA,{action:'cancel',runId:runA}))).status,200,'control: cancelRun of A');
  const scheduleA=(await runbooks.createSchedule(techA,{versionId:bookA.versionId,targets:[dA],confirm:true,recurrence:{kind:'interval',minutes:60}})).id;
  check(await answer(await post(runbooksApi,techA,{action:'cancel-schedule',scheduleId:scheduleA})),{status:200,body:{ok:true}},'control: cancelSchedule of A');
  const assignmentA=(await scopes.assignAutomationScope(techA,{templateId:runbookTemplateA.id,scopeType:'group',scopeId:gA,confirm:true})).id;
  const runAssignment=await answer(await post(automationApi,techA,{action:'run',confirm:true,assignmentId:assignmentA}));
  check([runAssignment.status,runAssignment.body.targets],[200,1],'control: startAutomationRun of A');
  check(await answer(await post(automationApi,techA,{action:'remove-assignment',confirm:true,assignmentId:assignmentA})),{status:200,body:{ok:true}},'control: removeAutomationScope of A');
  check((await answer(await post(runbooksApi,owner,{action:'cancel',runId:mixed}))).status,200,'the Owner cancels the mixed run');
  check(await answer(await post(automationApi,owner,{action:'remove-assignment',confirm:true,assignmentId:assignmentB})),{status:200,body:{ok:true}},'the Owner removes the assignment of B');
 }

 // ---- The catalog rules read no license ---------------------------------------------
 {
  check(/customerSeparationSql/.test(readFileSync('lib/server/catalog-ownership.ts','utf8')),true,'lib/server/catalog-ownership.ts uses the one separation rule');
 }

 // ---- Console devices carry their customer ----------------------------------------------
 {
  const {status,body}=await answer(await get(consoleApi,techA));
  check(status,200,'console GET');check(body.servers.find(row=>row.id===dA)?.customerId,customerA,'console: dA carries customer A');
 }
 console.log(`PASS: ${checks} catalog assertions across owners, runbooks, templates, roles, existence oracles and races.`);
}finally{d.close();}
