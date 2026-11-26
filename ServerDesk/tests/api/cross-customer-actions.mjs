// Cross-customer actions and the Owner rule for privileged roles, against the
// real libraries and routes on an isolated PostgreSQL test database. Customer A
// is the first customer, B is created by SQL. Across customers an action needs
// only the right portal.msp.crossCustomer: without it 403 CROSS_CUSTOMER_FORBIDDEN
// (apiError.crossCustomer.right), with it one customer entry per customer in the
// action's batch; a right revoked between the check and the commit writes
// nothing. Actions on one customer, the customer boundary, the preview warning,
// schedules (one customer only) and the Owner rule are covered as well.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
const {apiErrorBody,classifyFailure}=await import('../../lib/server/errors/failure.ts');
const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const time=Date.now(),clock={now:time},uuid=()=>crypto.randomUUID(),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
 const customerA='00000000-0000-4000-8000-000000000100',customerB=uuid();
 const HttpError=realHttpError;
 // The batch hook runs once, right before the next committing batch.
 let viewer=null,beforeBatch=null;const batches=[];
 const facade=hookDatabase(d,{batch:async texts=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}batches.push(texts);}});
 const server={db:()=>facade,now:()=>clock.now,config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>hash(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
  body:request=>request.json(),sameOrigin:()=>{},requireViewer:async()=>viewer,
  log:async(actor,action,target,serverId)=>{const ids=serverId===undefined?[null]:[...new Set(Array.isArray(serverId)?serverId:[serverId])];for(const id of ids)await d.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${clock.now},${actor},${action},${target},${id},${id?'device':'portal'})`);},
  // As lib/server/context.ts failure(): an HttpError answers with its status, code, message key and params.
  failure:error=>{const answer=error instanceof HttpError?classifyFailure(error):{status:503,body:apiErrorBody('apiError.storageUnavailable')};return Response.json(answer.body,{status:answer.status});}};
 // Routine writes (lib/step-up.ts) commit behind the live-session fence.
 const mfa={requireLiveSessions:async()=>{},mfaSessionFence:async(request,actor)=>localAuth.primaryGuard(request,actor),requireMfa:async()=>{},isMfaEnabled:async()=>true,readMfaManagementProof:async(_request,actor,token)=>({tokenHash:token,key:actor.principal,sessionHash:hash(actor.id+'mfa'),guard:sql`TRUE`})};
 const localAuth={primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor)};
 const v3={maintenanceBusy:async()=>false,modern:device=>JSON.parse(device.snapshot||'{}'),windowsPath:path=>String(path),CHUNK_SIZE:262144,MAX_TRANSFER:1<<30,securityFile:()=>false,bucket:()=>({})};
 const management={operations:{refresh:{readOnly:true,label:'Aktualisieren',schema:{safeParse:value=>({success:true,data:value})}}},safeTarget:()=>''};
 const releaseId=uuid(),release={id:releaseId,version:'4.6.0',manifest:'fixture',signature:'fixture'};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./local-auth':localAuth,'../identity/mfa':mfa,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,'./agent-protocol':v3,'../agent/agent-protocol':v3,'@/lib/server/agent/agent-protocol':v3,'./management':management,'../../management':management,'@/lib/management':management,'../agent/agent-crypto':{sealAgentSecrets:async()=>({})},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},
  '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
  '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},
  '@/lib/diagnostics':{diagnosticDefinitions:{},diagnosticSecurityAccess:()=>false,isDiagnosticKind:()=>false},'@/lib/file-operations':{fileSecurityAccess:()=>false},
  '@/lib/server/devices/device-lifecycle':{removeDevice:async()=>({}),removeDevices:async()=>({}),sweepRemovedTransfers:async()=>{}},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}},
  '@/lib/server/agent/releases':{releases:async()=>[],releaseEnvelopes:async()=>({release,path:release}),verifiedRelease:()=>release,retireRelease:async()=>({})}};
 const load=sourceLoader();
 const routes=loader=>({runbooks:loader('app/api/runbooks/route.ts'),releases:loader('app/api/releases/route.ts'),desired:loader('app/api/desired-state/route.ts')});
 const access=load('lib/server/identity/access.ts',imports),rbac=load('lib/server/identity/rbac.ts',imports),runbooks=load('lib/server/automation/runbooks.ts',imports),crossCustomer=load('lib/server/identity/cross-customer.ts',imports);
 const api=routes(file=>load(file,imports)),rbacApi=load('app/api/rbac/route.ts',imports);

 // ---- Fixture ----------------------------------------------------------------
 // The runs that existed before the action; target() names the one it started.
 let seenRuns=new Set();
 const insert=(table,row)=>insertRow(d,table,row);
 await insert('customers',{id:customerB,name:'Kunde B',created_at:time,updated_at:time});
 const snapshot=JSON.stringify({protocolVersion:3,agentCapabilities:['runbook-step','refresh','agent-update','release-paths'],mode:'Management',os:'Windows Server 2022',agentVersion:'4.3.0'});
 const dA1=uuid(),dA2=uuid(),dB1=uuid();
 for(const [id,name,customer] of [[dA1,'Server A1',customerA],[dA2,'Server A2',customerA],[dB1,'Server B1',customerB]])await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,snapshot,customer_id:customer});
 const actor=async(label,permissions)=>{const created=(await sourceActor(d,label,permissions)).actor;created.userId=created.id;
  await insert('mfa_sessions',{token_hash:hash(created.id+'mfa'),principal:created.principal,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
  await insert('mfa_accounts',{principal:created.principal,secret_enc:'fixture',recovery_hashes:'[]',last_counter:0,created_at:time-60_000});return created;};
 const owner=await actor('owner@cross.test',['*']);
 const techAB=await actor('tech-ab@cross.test',[...access.allPermissions]);
 const crossAB=await actor('cross-ab@cross.test',[...access.allPermissions]);
 const techA=await actor('tech-a@cross.test',[...access.allPermissions]);
 const iam=await actor('iam@cross.test',['portal.roles.manage','portal.roleAssignments.manage','portal.userGroups.manage']);
 // crossAB holds the right through its own global role, so the race can take exactly that away.
 const crossRole=uuid(),crossAssignment=uuid();
 await insert('rbac_roles',{id:crossRole,name:'Kundenübergreifend',description:'',permissions:JSON.stringify(['portal.msp.crossCustomer']),builtin:0,created_at:time});
 const grantCross=()=>insert('role_assignments',{id:crossAssignment,principal_type:'user',principal_id:crossAB.id,role_id:crossRole,scope_type:'global',scope_id:'*',created_at:time,created_by:owner.principal});
 await grantCross();
 await insert('rbac_roles',{id:'builtin-owner',name:'Owner',description:'',permissions:'["*"]',builtin:1,created_at:time});
 const assign=(customer,id)=>insert('customer_assignments',{customer_id:customer,principal_type:'user',principal_id:id,created_at:time,created_by:owner.principal});
 for(const who of [techAB,crossAB])for(const customer of [customerA,customerB])await assign(customer,who.id);
 for(const who of [techA,iam])await assign(customerA,who.id);
 const proof=async who=>{const token=uuid();await insert('mfa_management_proofs',{token_hash:token,principal:who.principal,session_hash:hash(who.id+'mfa'),expires_at:Date.now()+300_000});return token;};
 const manage=async(who,payload)=>{viewer=who;return rbac.manageRbac(who,payload,await rbac.prepareManagementAuthorization(new Request('https://cross.test/api/rbac'),who,await proof(who)));};
 const post=async(route,who,payload)=>{viewer=who;return route.POST(new Request('https://cross.test/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));};
 const get=async(route,who,query='')=>{viewer=who;return route.GET(new Request('https://cross.test/api'+query));};
 const answer=async response=>({status:response.status,body:await response.json()});
 const rejects=async(promise,status,message,label)=>{await assert.rejects(promise,error=>{assert.equal(error.status,status,label+': '+error.message);if(message)assert.equal(error.message,message,label);return true;},label);checks++;};
 const count=async statement=>Number((await d.one(statement)).n);
 const audits=()=>count(sql`SELECT count(*) AS n FROM audit`);
 const customerEntries=async()=>(await d.query(sql`SELECT actor,action,target,customer_id FROM audit WHERE server_id IS NULL AND customer_id IS NOT NULL ORDER BY id`));
 const book=await runbooks.createRunbookVersion(owner,{name:'Bibliothek',description:'',definition:{steps:[{id:'refresh',name:'Aktualisieren',kind:'diagnosis',operation:'refresh'}],parameters:[]}});
 const bookVersion=await d.one(sql`SELECT version FROM runbook_versions WHERE id=${book.versionId}`).then(row=>row===null?null:row.version);
 // Non-admins assign the desired-state configurations they created, so each actor gets its own.
 const desiredVersions={};let desiredVersion='';
 for(const who of [owner,techAB,crossAB,techA]){
  const config=uuid(),version=uuid();desiredVersions[who.id]=version;
  await insert('desired_configs',{id:config,name:'Baseline '+who.label,description:'',created_by:who.principal,created_at:time});
  await insert('desired_versions',{id:version,config_id:config,version:3,engine:'dsc3',content:'{}',sha256:'0'.repeat(64),created_by:who.principal,created_at:time});
 }
 const text={
  right:serverText('apiError.crossCustomer.right'),
  schedule:serverText('apiError.crossCustomer.schedule'),
  warning:serverText('serverMessage.runbook.crossCustomerWarning',{customers:2}),
  role:serverText('apiError.rbac.privilegedRoleOwnerOnly'),
  group:serverText('apiError.rbac.privilegedGroupOwnerOnly'),
  customerRole:serverText('apiError.customer.rolePermissions'),
  notFound:serverText('apiError.device.notFound'),
 };
 // The preview warning is a serverMessage with its key and params (lib/server-messages.ts).
 check([crossCustomer.crossCustomerRightMessage,crossCustomer.crossCustomerScheduleMessage,serverText('serverMessage.runbook.crossCustomerWarning',{customers:2}),rbac.privilegedRoleOwnerOnlyMessage,rbac.privilegedGroupOwnerOnlyMessage],[text.right,text.schedule,text.warning,text.role,text.group],'UI copy of the server texts');

 // Each refusal as [status, code, message key] (lib/errors/api-error-keys.ts).
 const refusal={
  right:[403,'CROSS_CUSTOMER_FORBIDDEN','apiError.crossCustomer.right'],
  schedule:[400,'INVALID_REQUEST','apiError.crossCustomer.schedule'],
  notFound:[404,'NOT_FOUND','apiError.device.notFound'],
 };
 const warningKey='serverMessage.runbook.crossCustomerWarning';

 // ---- The right ------------------------------------------------------------
 {
  check(access.crossCustomerPermission,'portal.msp.crossCustomer','crossCustomerPermission');
  const {translate}=load('lib/i18n/translate.ts');
  check(access.portalPermissionDefinitions.find(entry=>entry.id==='portal.msp.crossCustomer')?.labelKey,'crossCustomer.right','the right is a portal right with the catalog key of its name');
  check([translate('en','crossCustomer.right'),translate('de','crossCustomer.right')],['Start actions for several customers','Aktionen für mehrere Kunden starten'],'the name in both languages');
  const {status,body}=await answer(await get(rbacApi,owner));
  check([status,body.permissions.find(entry=>entry.id==='portal.msp.crossCustomer')],[200,{id:'portal.msp.crossCustomer',labelKey:'crossCustomer.right'}],'GET /api/rbac lists the right with its label key');
  check([body.permissions.map(entry=>entry.id),body.permissions.filter(entry=>Object.keys(entry).sort().join()!=='id,labelKey'||/[äöüÄÖÜß]/.test(JSON.stringify(entry))).length],[[...access.allPermissions,...access.allPortalPermissions],0],'GET /api/rbac sends every right as {id,labelKey} in the definition order, with no German text');
  check((await access.globalPermissions(owner)).includes('portal.msp.crossCustomer'),true,'Owners hold the right through *');
  check([await access.hasGlobalPermission(crossAB,'portal.msp.crossCustomer'),await access.hasGlobalPermission(techAB,'portal.msp.crossCustomer')],[true,false],'crossAB holds it, techAB not');
  await rejects(manage(owner,{action:'create-role',name:'Kundenrolle',permissions:['view','portal.msp.crossCustomer'],customerId:customerA}),400,text.customerRole,'a customer role with the right');
  check(/permissions:allPortalPermissions\.filter\(right=>right!=='portal\.operator'&&right!==crossCustomerPermission[&)]/.test(readFileSync('lib/server/identity/rbac.ts','utf8')),true,'the built-in User Access Administrator does not get the right');
 }

 // ---- Gate, customer entries and the race per action ---------------------------------------------
 const kinds={
  runbook:{label:'Runbook',run:(route,who,targets)=>post(route.runbooks,who,{action:'run',versionId:book.versionId,targets,confirm:true}),
   written:()=>count(sql`SELECT count(*) AS n FROM runbook_runs`),marker:'INSERT INTO runbook_runs',entry:'Runbook kundenübergreifend gestartet',
   target:async()=>{const id=(await d.query(sql`SELECT id FROM runbook_runs`)).map(row=>row.id).find(id=>!seenRuns.has(id))??null;return `Bibliothek / v${bookVersion} / ${id}`;},deviceAction:'Runbook gestartet',reset:async()=>{}},
  // A rollout relies on the MFA login session and sends no managementToken.
  agent:{label:'Agent-Update',run:async(route,who,targets)=>post(route.releases,who,{action:'deploy',releaseId,serverIds:targets,confirm:true}),
   written:()=>count(sql`SELECT count(*) AS n FROM jobs WHERE action='agent-update'`),marker:'INSERT INTO jobs',entry:'Agent-Update kundenübergreifend geplant',
   target:async()=>'4.6.0',deviceAction:'Agentupdate geplant',reset:()=>d.exec(sql`DELETE FROM jobs WHERE action='agent-update'`)},
  desired:{label:'Desired State',run:(route,who,targets)=>{desiredVersion=desiredVersions[who.id];return post(route.desired,who,{action:'assign',versionId:desiredVersion,targets});},
   written:()=>count(sql`SELECT count(*) AS n FROM desired_assignments`),marker:'INSERT INTO desired_assignments',entry:'Desired State kundenübergreifend zugewiesen',
   target:async()=>`${desiredVersion} / v3`,deviceAction:'Desired-State-Version zugewiesen',reset:()=>d.exec(sql`DELETE FROM desired_assignments`)},
 };
 const state=async kind=>({written:await kind.written(),audits:await audits()});
 const refused=async(kind,route,who,targets,expected,label)=>{
  await kind.reset();const before=await state(kind),{status,body}=await answer(await kind.run(route,who,targets));
  check([status,body.code,body.messageKey],expected,label);check(await state(kind),before,label+': nothing written');
 };
 const started=async(kind,route,who,targets,label)=>{await kind.reset();const {status,body}=await answer(await kind.run(route,who,targets));check(status,200,label+': '+JSON.stringify(body));return body;};
 const deviceCustomers=async(kind,targets)=>(await d.query(sql`SELECT DISTINCT customer_id FROM audit WHERE action=${kind.deviceAction} AND server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(targets)}::jsonb)) ORDER BY customer_id`)).map(row=>row.customer_id);
 for(const kind of Object.values(kinds)){
  const L=kind.label;
  // Single customer: unchanged, no customer entry, device rows carry customer A.
  let entries=(await customerEntries()).length;
  await started(kind,api,techAB,[dA1,dA2],L+': techAB on A1+A2');
  check([(await customerEntries()).length,await deviceCustomers(kind,[dA1,dA2])],[entries,[customerA]],L+': no customer entry; device rows carry customer A');
  // Without the right: 403 before anything is written.
  await refused(kind,api,techAB,[dA1,dB1],refusal.right,L+': techAB on A1+B1');
  // The boundary comes first: techA does not see dB1.
  await refused(kind,api,techA,[dA1,dB1],refusal.notFound,L+': techA on A1+B1');
  // With the right (crossAB, owner): exactly one customer entry per customer, in the action's batch.
  for(const [who,targets,counts] of [[crossAB,[dA1,dA2,dB1],['2 von 3','1 von 3']],[owner,[dA1,dB1],['1 von 2','1 von 2']]]){
   entries=(await customerEntries()).length;batches.length=0;seenRuns=new Set((await d.query(sql`SELECT id FROM runbook_runs`)).map(row=>row.id));
   await started(kind,api,who,targets,`${L}: ${who.label} across A and B`);
   const added=(await customerEntries()).slice(entries),target=await kind.target();
   check(added,[{actor:kind===kinds.desired?who.id:who.label,action:kind.entry,target:`${target} · ${counts[0]} Geräten`,customer_id:customerA},{actor:kind===kinds.desired?who.id:who.label,action:kind.entry,target:`${target} · ${counts[1]} Geräten`,customer_id:customerB}].sort((x,y)=>x.customer_id.localeCompare(y.customer_id)),`${L}: ${who.label} writes one entry per customer`);
   const commit=batches.find(list=>list.some(statement=>statement.startsWith(kind.marker)));
   check(commit?.filter(statement=>/^INSERT INTO audit\(at,actor,action,target,server_id,scope,customer_id\)/.test(statement)).length,2,`${L}: the customer entries are in the action's batch`);
   check(await deviceCustomers(kind,targets),[customerA,customerB].sort(),`${L}: device rows carry their device's customer`);
  }
  // Race: the right goes away between the check and the commit; the gate answers again.
  await kind.reset();const before=await state(kind);
  beforeBatch=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${crossAssignment}`);
  const reply=await answer(await kind.run(api,crossAB,[dA1,dB1]));
  check([reply.status,reply.body.code,reply.body.messageKey],refusal.right,L+': race, right revoked');check(await state(kind),before,L+': race, right revoked: nothing written');
  await grantCross();await kind.reset();
 }
 // ---- Preview, schedules and the schedule tick -----------------------------------------
 {
  const dryrun=async(who,targets)=>answer(await post(api.runbooks,who,{action:'dryrun',versionId:book.versionId,targets}));
  const denied=await dryrun(techAB,[dA1,dB1]);check([denied.status,denied.body.code,denied.body.messageKey],refusal.right,'preview: techAB across A and B');
  const warned=await dryrun(crossAB,[dA1,dB1]);check([warned.status,warned.body.warnings.find(warning=>warning.key===warningKey)?.params],[200,{customers:2}],'preview: crossAB gets the warning');
  const single=await dryrun(techAB,[dA1,dA2]);check([single.status,single.body.warnings.some(warning=>warning.key===warningKey)],[200,false],'preview: single customer has no warning');
  const schedules=()=>count(sql`SELECT count(*) AS n FROM runbook_schedules`);
  const recurrence={kind:'interval',minutes:60};const before=await schedules();
  const across=await answer(await post(api.runbooks,owner,{action:'schedule',versionId:book.versionId,targets:[dA1,dB1],confirm:true,recurrence}));
  check([across.status,across.body.code,across.body.messageKey,await schedules()],[...refusal.schedule,before],'schedule: across A and B is refused, also for the Owner');
  const ownA=await answer(await post(api.runbooks,owner,{action:'schedule',versionId:book.versionId,targets:[dA1,dA2],confirm:true,recurrence}));
  check([ownA.status,await schedules()],[200,before+1],'schedule: one customer works');
  // A schedule over A and B from direct SQL: the tick switches it off and starts nothing.
  const legacy=uuid();await d.exec(sql`INSERT INTO runbook_schedules(id,version_id,actor,targets,parameters,recurrence,next_due,catchup_seconds,concurrency,failure_stop,approved_at,created_at) VALUES(${legacy},${book.versionId},${owner.principal},${JSON.stringify([dA1,dB1])},${'{}'},${'{"kind":"interval","minutes":60}'},${clock.now-1000},${3600},${1},${1},${time},${time})`);
  await d.exec(sql`UPDATE runbook_schedules SET enabled=0 WHERE id<>${legacy}`);
  await runbooks.tickAutomation(dA1,JSON.parse(snapshot));
  check(await d.one(sql`SELECT enabled FROM runbook_schedules WHERE id=${legacy}`).then(row=>row===null?null:row.enabled),0,'tick: the schedule over A and B is switched off');
  check(await count(sql`SELECT count(*) AS n FROM runbook_runs WHERE schedule_id=${legacy}`),0,'tick: no run');
  check((await d.query(sql`SELECT actor,target,server_id FROM audit WHERE action='Runbook-Zeitplan über mehrere Kunden deaktiviert' ORDER BY server_id`)),[dA1,dB1].sort().map(id=>({actor:'System',target:legacy,server_id:id})),'tick: device rows name the schedule');
 }

 // ---- Owner rule for privileged roles and groups ----------------------------------------------
 {
  const roleRows=()=>count(sql`SELECT count(*) AS n FROM rbac_roles`),assignmentRows=()=>count(sql`SELECT count(*) AS n FROM role_assignments`),memberRows=()=>count(sql`SELECT count(*) AS n FROM user_group_members`);
  const snapshotRows=async()=>[await roleRows(),await assignmentRows(),await memberRows(),await d.one(sql`SELECT string_agg(permissions,',' ORDER BY id) AS p FROM rbac_roles`).then(row=>row===null?null:row.p),await count(sql`SELECT count(*) AS n FROM user_groups WHERE enabled=1`)];
  const privileged=await manage(owner,{action:'create-role',name:'Senior',permissions:['view','portal.msp.crossCustomer']});
  const plain=await manage(owner,{action:'create-role',name:'Plain',permissions:['view']});
  const team=await manage(owner,{action:'create-group',name:'Owners'});await manage(owner,{action:'add-assignment',subjectType:'group',subjectId:team.id,roleId:'builtin-owner',scopeType:'global',scopeId:'*'});
  const off=await manage(owner,{action:'create-group',name:'Senioren'});await manage(owner,{action:'add-assignment',subjectType:'group',subjectId:off.id,roleId:privileged.id,scopeType:'global',scopeId:'*'});
  await manage(owner,{action:'update-group',id:off.id,name:'Senioren',description:'',enabled:false});
  const before=await snapshotRows();
  await rejects(manage(iam,{action:'create-role',name:'Alles',permissions:['*']}),403,text.role,'iam: create-role with *');
  await rejects(manage(iam,{action:'create-role',name:'Mehrere',permissions:['view','portal.msp.crossCustomer']}),403,text.role,'iam: create-role with the right');
  await rejects(manage(iam,{action:'update-role',id:plain.id,name:'Plain',permissions:['view','portal.msp.crossCustomer']}),403,text.role,'iam: update-role adds the right');
  await rejects(manage(iam,{action:'update-role',id:privileged.id,name:'Senior neu',permissions:['view','portal.msp.crossCustomer']}),403,text.role,'iam: update-role of a privileged role');
  await rejects(manage(iam,{action:'delete-role',id:privileged.id}),403,text.role,'iam: delete-role of a privileged role');
  await rejects(manage(iam,{action:'add-assignment',subjectType:'user',subjectId:iam.id,roleId:'builtin-owner',scopeType:'global',scopeId:'*'}),403,text.role,'iam: the Owner role to itself');
  await rejects(manage(iam,{action:'add-assignment',subjectType:'user',subjectId:techA.id,roleId:privileged.id,scopeType:'global',scopeId:'*'}),403,text.role,'iam: a privileged role to someone else');
  await rejects(manage(iam,{action:'add-member',groupId:team.id,userId:techA.id}),403,text.group,'iam: add-member to a group with the Owner role');
  await rejects(manage(iam,{action:'update-group',id:off.id,name:'Senioren',description:'',enabled:true}),403,text.group,'iam: enabling a group with a privileged role');
  check(await snapshotRows(),before,'iam: nothing written');
  // Removing stays possible.
  await manage(owner,{action:'add-member',groupId:team.id,userId:techA.id});
  check((await manage(iam,{action:'remove-member',groupId:team.id,userId:techA.id})).ok,true,'iam: removing a member stays possible');
  // The Owner may do all of it.
  const ownerRole=await manage(owner,{action:'create-role',name:'Mehr',permissions:['portal.msp.crossCustomer']});
  await manage(owner,{action:'update-role',id:ownerRole.id,name:'Mehr',permissions:['view','portal.msp.crossCustomer']});
  const ownerGrant=await manage(owner,{action:'add-assignment',subjectType:'user',subjectId:techA.id,roleId:ownerRole.id,scopeType:'global',scopeId:'*'});
  await manage(owner,{action:'delete-assignment',id:ownerGrant.id});await manage(owner,{action:'delete-role',id:ownerRole.id});
  await manage(owner,{action:'add-member',groupId:team.id,userId:techA.id});await manage(owner,{action:'update-group',id:off.id,name:'Senioren',description:'',enabled:true});
  check([await count(sql`SELECT count(*) AS n FROM rbac_roles WHERE id=${ownerRole.id}`),await count(sql`SELECT count(*) AS n FROM user_group_members WHERE group_id=${team.id} AND user_id=${techA.id}`),await count(sql`SELECT count(*) AS n FROM user_groups WHERE id=${off.id} AND enabled=1`)],[0,1,1],'the Owner creates, changes, assigns, deletes, adds members and enables');
  // Race: the role becomes privileged between the check and the commit.
  const assignmentsBefore=await assignmentRows();
  beforeBatch=()=>d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(['portal.msp.crossCustomer','view'])} WHERE id=${plain.id}`);
  await rejects(manage(iam,{action:'add-assignment',subjectType:'user',subjectId:techA.id,roleId:plain.id,scopeType:'global',scopeId:'*'}),403,null,'race: the role became privileged');
  check(await assignmentRows(),assignmentsBefore,'race: no assignment');
 }

 // ---- The gate -------------------------------------------------------------------------
 {
  check([typeof crossCustomer.authorizeCrossCustomerAction,typeof crossCustomer.authorizeTargetCustomers],['function','function'],'lib/server/identity/cross-customer.ts holds the gate');
  await assert.rejects(crossCustomer.authorizeCrossCustomerAction(techAB),error=>{check([error.status,error.code,error.messageKey],refusal.right,'the gate refuses techAB');return true;});
  check(!!await d.one(sql`SELECT 1 AS ok WHERE ${await crossCustomer.authorizeCrossCustomerAction(crossAB)}`),true,'the guard of crossAB holds');
 }

 console.log(`PASS: ${checks} cross-customer assertions: the right, customer entries, the race, one customer, the boundary, the preview, schedules and the Owner rule for privileged roles.`);
}finally{d.close();}
