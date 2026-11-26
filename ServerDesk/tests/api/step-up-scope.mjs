// MFA only at login and for critical actions. Organizing devices in
// /api/access relies on the MFA login session behind the live-session fence,
// and so does deleting an empty device group; direct grants keep the fresh
// step-up proof; removing devices from the portal needs one. Real routes and libraries (access,
// console, rbac, membership, lifecycle, mfa, local-auth, audit) run against an
// an isolated migrated PostgreSQL test database. log() throws, so every audit row comes from a batch.
import {serverText} from '../support/server-text.mjs';
// The body keeps the codes a client branches on; the generic codes per status are checked in tests/repo/error-codes.mjs.
import {HttpError as realHttpError,genericCode} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';

import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://stepup.test',time=Date.now();
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
 // The one-shot hook runs right before the next batch; every batch's SQL is recorded.
 let beforeBatch=null,current=null;const batches=[];
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},record:batches});
 const server={
  db:()=>facade,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  requireViewer:async()=>{if(!current)throw new HttpError(401,'Bitte anmelden.','IDENTITY_LOGIN_REQUIRED');return current;},
  requireAuthIdentity:async()=>current,
  log:async()=>{throw new Error('log() must not be used by these actions');},
  failure:e=>Response.json({error:e instanceof HttpError?e.message:serverText('apiError.storageUnavailable'),...(e instanceof HttpError&&e.code&&!genericCode(e.code)?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 // Leaves the routes import but these flows never reach (agent packages, R2, RDP).
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,
  './agent-protocol':{bucket:()=>({}),CHUNK_SIZE:262144,MAX_TRANSFER:1<<30,securityFile:()=>false},'../agent/agent-protocol':{bucket:()=>({}),CHUNK_SIZE:262144,MAX_TRANSFER:1<<30,securityFile:()=>false},'@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},'../devices/transfers':{clearTransfer:async()=>{}},'./transfers':{clearTransfer:async()=>{}},
  '@/lib/management':{operations:{},safeTarget:()=>''},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},'@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
  '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
 const load=sourceLoader();
 const accessApi=load('app/api/access/route.ts',imports),consoleApi=load('app/api/console/route.ts',imports),stepUp=load('lib/step-up.ts',imports);

 // ---- One dependency-free classification, read by server and client ----
 {
  const source=readFileSync('lib/step-up.ts','utf8');
  check(/^\s*import\b|\brequire\(|\bimport\(/m.test(source),false,'lib/step-up.ts imports nothing');
  check([...stepUp.accessStepUpActions].sort(),['delete-grant','set-grant'],'critical access actions; delete-group asks only in its risky case');
  check([...stepUp.accessRoutineActions].sort(),['assign-device','create-group','set-device-memberships','update-device-memberships','update-group'],'routine access actions');
  check([...stepUp.deviceRemovalActions].sort(),['remove-server','remove-servers'],'device removal actions without the removed revoke action');
  // Device moves need a proof only when they widen access; the set stays routine otherwise.
  check([...stepUp.accessWideningStepUpActions].sort(),['assign-device','set-device-memberships','update-device-memberships'],'access actions that need step-up when they widen access');
  for(const action of stepUp.accessWideningStepUpActions)check([stepUp.accessActionNeedsStepUpWhenWidening(action),stepUp.accessRoutineActions.has(action)],[true,true],action+' is routine unless it widens access');
  for(const action of ['create-group','update-group','delete-group',undefined,null,42])check(stepUp.accessActionNeedsStepUpWhenWidening(action),false,'no widening check: '+String(action));
  check(/widens access/.test(source)&&/not an ancestor of the device's current group/.test(source),true,'the comment header names the widening rule');
  for(const action of stepUp.accessRoutineActions)check(stepUp.accessActionNeedsStepUp(action),false,action+' needs no step-up');
  for(const action of stepUp.accessStepUpActions)check(stepUp.accessActionNeedsStepUp(action),true,action+' needs step-up');
  for(const action of [undefined,null,42,'unknown'])check(stepUp.accessActionNeedsStepUp(action),false,'not classified: '+String(action));
  for(const action of stepUp.deviceRemovalActions)check(stepUp.isDeviceRemovalAction(action),true,action+' removes devices');
  check(stepUp.isDeviceRemovalAction('enroll'),false,'enroll is no removal');
  // Rule 6: a maintenance save asks only when a retention gets shorter (lib/step-up.ts, tests/lib/step-up-rules.mjs).
  check(['maintenanceStepUpActions','maintenanceActionNeedsStepUp','notificationChannelStepUpActions','notificationChannelActionNeedsStepUp'].filter(name=>name in stepUp),[],'no maintenance action list and no notification channel step-up');
  check(/maintenanceSetNeedsStepUp\(/.test(readFileSync('ui/settings/retention-model.ts','utf8'))&&/maintenanceSaveNeedsStepUp\(/.test(readFileSync('ui/settings/maintenance-panel.tsx','utf8')),true,'the maintenance page reads lib/step-up.ts through its model');
  check(/notificationChannel\w*StepUp/.test(readFileSync('ui/settings/notifications-panel.tsx','utf8')),false,'the notifications page keeps no step-up list');
  const table=readFileSync('docs/portal-sessions.md','utf8');
  check(['## Which actions ask for MFA again','| `/api/maintenance` `set` | Only when the audit retention or the job retention gets shorter','| `/api/notifications/channels` `create`, `update`, `delete`, `set-enabled`, `rotate-secret` | No ','| `/api/access` `delete-group` | Only when the group has a device or a devicegroup role assignment'].filter(line=>!table.includes(line)),[],'the docs table names the new rules');
  // Rule 6: saving the organization key or a customer key of the AI assistant; removal, tests and the personal key rely on the login session.
  check([...stepUp.assistantSettingsStepUpActions],['set-organization-key','set-customer-key'],'AI assistant actions that need step-up');
  check(['set-organization-key','remove-organization-key','set-customer-key','remove-customer-key','test-organization-key','test-customer-key','set-personal-key','remove-personal-key','test-personal-key',undefined].map(stepUp.assistantSettingsActionNeedsStepUp),[true,false,true,false,false,false,false,false,false,false],'removal, tests and personal keys need no step-up');
  check(/assistantSettingsActionNeedsStepUp\(/.test(readFileSync('ui/settings/assistant-settings-panel.tsx','utf8')),true,'the AI assistant page reads lib/step-up.ts');
  check(table.includes('| `/api/assistant` `run` with a PowerShell command | Yes |'),true,'the table names the assistant scripts');
  check(table.includes('| `/api/terminal` `open` | Yes (to resume your own live shell: no) | Remote SYSTEM shell |'),true,'the table names the SYSTEM terminal');
  // Rule 5: a PowerShell script from the AI assistant is unrestricted execution, like the terminal; portal actions, questions and follow-ups are routine.
  check([...stepUp.assistantStepUpCommands],['powershell'],'AI assistant commands that need step-up');
  check([stepUp.assistantActionNeedsStepUp('run',{type:'powershell'}),stepUp.assistantActionNeedsStepUp('run',{type:'action',kind:'restart-service'}),stepUp.assistantActionNeedsStepUp('ask',{type:'powershell'}),stepUp.assistantActionNeedsStepUp('run',null),stepUp.assistantActionNeedsStepUp('run','powershell')],[true,false,false,false,false],'only a script run needs step-up');
  for(const file of ['lib/server/devices/assistant-commands.ts','ui/devices/assistant/assistant-proposals.ts'])check(/assistantActionNeedsStepUp\(/.test(readFileSync(file,'utf8')),true,file+' reads lib/step-up.ts');
  // The critical sets keep their members. Distributing signed agent and plugin
  // releases is routine: release deploy and every plugin action left the
  // classification, and no source file reads a plugin step-up list any more.
  check(Object.fromEntries(['accessStepUpActions','accessWideningStepUpActions','deviceRemovalActions','consoleStepUpActions','terminalStepUpActions','sessionSettingsStepUpActions','assistantSettingsStepUpActions','assistantStepUpCommands'].map(name=>[name,[...stepUp[name]].sort()])),{
   accessStepUpActions:['delete-grant','set-grant'],accessWideningStepUpActions:['assign-device','set-device-memberships','update-device-memberships'],deviceRemovalActions:['remove-server','remove-servers'],consoleStepUpActions:['enroll','move-customer','remove-server','remove-servers'],terminalStepUpActions:['open'],
   sessionSettingsStepUpActions:['set','set-idle-mfa','set-idle-timeout'],assistantSettingsStepUpActions:['set-customer-key','set-organization-key'],assistantStepUpCommands:['powershell'],
  },'the critical sets keep their members; release deploy is routine');
  check(['releaseStepUpActions','releaseActionNeedsStepUp'].filter(name=>name in stepUp),[],'lib/step-up.ts exports no release step-up set or predicate: no release action needs a proof');
  check(/prepareManagementAuthorization/.test(readFileSync('app/api/releases/route.ts','utf8')),false,'app/api/releases/route.ts reads no step-up proof');
  check(['pluginStepUpActions','pluginActionNeedsStepUp'].filter(name=>name in stepUp),[],'lib/step-up.ts exports no plugin step-up list');
  {
   const sources=dir=>readdirSync(dir,{recursive:true}).map(String).filter(file=>/\.(ts|tsx)$/.test(file)).map(file=>dir+'/'+file.replaceAll('\\','/'));
   const users=[...sources('app'),...sources('ui'),...sources('lib')].filter(file=>/pluginStepUpActions|pluginActionNeedsStepUp/.test(readFileSync(file,'utf8')));
   check(users,[],'no source file under app/ or lib/ references the plugin step-up list');
  }
  // Both sides read the module; neither keeps its own list.
  for(const [file,pattern] of [['lib/server/identity/access-admin.ts',/accessActionNeedsStepUp\(p\.action\)/],['lib/server/identity/rbac.ts',/deviceGroupDeleteNeedsStepUp\(/],['app/api/console/route.ts',/isDeviceRemovalAction\(p\.action\)/],['ui/devices/fleet/groups-model.ts',/accessActionNeedsStepUp\(body\.action\)/],['ui/devices/device/device-removal.tsx',/isDeviceRemovalAction\(payload\.action\)/],['ui/shell/console-action.ts',/isDeviceRemovalAction\(payload\.action\)/]]){
   const text=readFileSync(file,'utf8');check(pattern.test(text),true,file+' reads lib/step-up.ts');check(/'remove-server'\|\||===\s*'remove-servers'\|\||\['delete-group','set-grant'/.test(text),false,file+' keeps no own list');
  }
 }

 // ---- Fixture -------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const one=statement=>d.one(statement);
 const count=async(sql,...bindings)=>Number((await one(sql,...bindings)).n);
 async function account(label,permissions=['*']){
  const {actor}=await sourceActor(d,label,permissions);actor.userId=actor.id;
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await insert('mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:'[]',last_counter:-1,created_at:time,authenticators_migrated:1});
  return actor;
 }
 // A signed-in browser: bound primary session, live MFA session and, unless
 // `proof` is false, one fresh management proof.
 async function browser(actor,{proof=true}={}){
  const at=Date.now(),primary=token(),session=token(),management=token();
  await insert('mfa_sessions',{token_hash:sha(session),principal:actor.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  if(proof)await insert('mfa_management_proofs',{token_hash:sha(management),principal:actor.principal,session_hash:sha(session),expires_at:at+300_000});
  return {primary,session,management:proof?management:null};
 }
 const post=async(api,path,actor,b,payload)=>{current=actor;batches.length=0;const response=await api.POST(new Request(origin+path,{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
 const access=(actor,b,payload)=>post(accessApi,'/api/access',actor,b,payload);
 const removal=(actor,b,payload)=>post(consoleApi,'/api/console',actor,b,payload);
 const group=async(name,parent=null)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent});return id;};
 const device=async name=>{const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,snapshot:'{}'});return id;};
 const proofs=()=>count(sql`SELECT count(*) AS n FROM mfa_management_proofs`);
 const proofExists=async value=>await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(value)}`)===1;
 const audits=()=>count(sql`SELECT count(*) AS n FROM audit`);
 const members=async server=>(await d.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${server} ORDER BY group_id`)).map(row=>row.group_id);
 const touchesProof=()=>batches.some(batch=>batch.some(sql=>/mfa_management_proofs WHERE token_hash/.test(sql)));
 const owner=await account('owner@stepup.test');

 // ---- Routine actions without managementToken -----------------------------------
 const routine=async(label,run)=>{
  const b=await browser(owner,{proof:false}),proofsBefore=await proofs(),auditsBefore=await audits();
  const result=await run(b);
  check(result.status,200,label+': 200 without managementToken ('+result.body.error+')');
  check(await audits(),auditsBefore+1,label+': one audit row');
  check(await proofs(),proofsBefore,label+': no proof row is deleted');
  check(touchesProof(),false,label+': no proof row is read or deleted in the batch');
  check(batches.filter(batch=>batch.some(sql=>/^INSERT INTO audit\b/.test(sql))).length,1,label+': change and audit row commit in one batch');
  return result;
 };
 const target=await group('Ziel'),other=await group('Andere'),a=await device('SRV-A'),b2=await device('SRV-B');
 const created=await routine('create-group',b=>access(owner,b,{action:'create-group',name:'Neue Gruppe',description:'Beschreibung'}));
 check(await one(sql`SELECT name,description FROM device_groups WHERE id=${created.body.id}`),{name:'Neue Gruppe',description:'Beschreibung'},'create-group: the group exists');
 check((await one(sql`SELECT target FROM audit WHERE action='Gerätegruppe erstellt' ORDER BY id DESC`)).target,'Neue Gruppe','create-group: audit row content as before');
 await routine('update-group',b=>access(owner,b,{action:'update-group',id:created.body.id,name:'Umbenannt',description:'Neu'}));
 check(await one(sql`SELECT name,description FROM device_groups WHERE id=${created.body.id}`),{name:'Umbenannt',description:'Neu'},'update-group: name and description');
 await routine('assign-device',b=>access(owner,b,{action:'assign-device',serverIds:[a],groupId:target}));check(await members(a),[target],'assign-device moves the device');
 await routine('set-device-memberships',b=>access(owner,b,{action:'set-device-memberships',serverIds:[b2],groupId:other,assigned:true}));check(await members(b2),[other],'set-device-memberships');
 await routine('update-device-memberships',b=>access(owner,b,{action:'update-device-memberships',groupId:target,addIds:[b2],removeIds:[a]}));check([await members(a),await members(b2)],[[],[target]],'update-device-memberships adds and removes');

 // A supplied token on a routine action is ignored and its row remains.
 {
  const b=await browser(owner);
  for(const payload of [{action:'create-group',name:'Mit Token',description:''},{action:'update-group',id:created.body.id,name:'Mit Token',description:''},{action:'assign-device',serverIds:[a],groupId:other},{action:'set-device-memberships',serverIds:[a],groupId:other,assigned:false},{action:'update-device-memberships',groupId:other,addIds:[a],removeIds:[]}]){
   const result=await access(owner,b,{...payload,managementToken:b.management});
   check(result.status,200,payload.action+' with a token: 200');check(await proofExists(b.management),true,payload.action+': the token row remains');check(touchesProof(),false,payload.action+': the token is not read in the batch');
  }
 }

 // ---- The routine commit keeps the live-session fence ---------------------------
 const races={
  logout:(b)=>()=>d.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sha(b.primary)}`),
  idle:(b)=>()=>d.exec(sql`UPDATE mfa_sessions SET idle_expires_at=${Date.now()-1000} WHERE token_hash=${sha(b.session)}`),
  absolute:(b)=>()=>d.exec(sql`UPDATE mfa_sessions SET expires_at=${Date.now()-1000} WHERE token_hash=${sha(b.session)}`),
  passwordReset:()=>()=>d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${owner.id}`),
 };
 const snapshot=async()=>{const state={};for(const table of ['device_groups','device_group_members','audit'])state[table]=(await d.query(sql`SELECT * FROM ${sql.ident(table)}`)).map(row=>JSON.stringify(row)).sort();return state;};
 const raceGroup=await group('Rennen'),raceDevice=await device('SRV-RACE');
 for(const [name,mutate] of Object.entries(races))for(const payload of [{action:'create-group',name:'Zu spät',description:''},{action:'update-group',id:raceGroup,name:'Zu spät',description:''},{action:'assign-device',serverIds:[raceDevice],groupId:raceGroup},{action:'set-device-memberships',serverIds:[raceDevice],groupId:raceGroup,assigned:true},{action:'update-device-memberships',groupId:raceGroup,addIds:[raceDevice],removeIds:[]}]){
  const b=await browser(owner,{proof:false}),before=await snapshot();beforeBatch=mutate(b);
  const result=await access(owner,b,payload);
  check(beforeBatch,null,`${payload.action} ${name}: the hook ran right before the batch`);
  // The session's own reason, not a misleading rights message.
  check([result.status,['SESSION_EXPIRED','IDENTITY_LOGIN_REQUIRED'].includes(result.body.code)],[401,true],`${payload.action} ${name}: refused with the session's 401, got ${result.status} ${result.body.code} ${result.body.error}`);
  check(await snapshot(),before,`${payload.action} ${name}: no group, membership or audit row`);
  check(batches.at(-1).some(sql=>sql.includes('live_session.idle_expires_at>')),true,`${payload.action} ${name}: the committing statement carries the session fence`);
  if(name==='passwordReset')await d.exec(sql`UPDATE local_users SET auth_version=1 WHERE id=${owner.id}`);
 }

 // A routine write refused for lost rights (sessions live) keeps its 403 rights message.
 {
  const b=await browser(owner,{proof:false}),before=await snapshot();beforeBatch=()=>d.exec(sql`UPDATE rbac_roles SET permissions='["view"]' WHERE id IN (SELECT role_id FROM role_assignments WHERE principal_id=${owner.id})`);
  const result=await access(owner,b,{action:'update-group',id:raceGroup,name:'Ohne Recht',description:''});
  check([result.status,result.body.error],[403,serverText('apiError.group.rightRevoked')],'lost rights: 403 with the rights message');check(await snapshot(),before,'lost rights: nothing written');
  await d.exec(sql`UPDATE rbac_roles SET permissions='["*"]' WHERE id IN (SELECT role_id FROM role_assignments WHERE principal_id=${owner.id})`);
 }

 // ---- An empty group deletes behind the session fence ----------------------------
 {
  const emptyGroup=await group('Leer');
  await routine('delete-group of an empty group',b=>access(owner,b,{action:'delete-group',id:emptyGroup,confirm:true}));
  check(await count(sql`SELECT count(*) AS n FROM device_groups WHERE id=${emptyGroup}`),0,'the empty group is deleted without a proof');
 }

 // ---- set-grant and delete-grant keep the step-up ---------------------------------
 {
  const recipient=await account('recipient@stepup.test',['view']),grantGroup=await group('Freigabe');
  const role=uuid();await insert('rbac_roles',{id:role,name:'Leser '+role,description:'',permissions:'["view"]',builtin:0,created_at:time});
  // The grant to remove lives on its own group: set-grant replaces the recipient's other assignments on its group.
  const assignment=uuid(),revokeGroup=await group('Entzug');await insert('role_assignments',{id:assignment,principal_type:'user',principal_id:recipient.id,role_id:role,scope_type:'devicegroup',scope_id:revokeGroup,created_at:time,created_by:'fixture'});
  const critical=[
   ['set-grant',{action:'set-grant',groupId:grantGroup,principal:recipient.principal,role:'viewer',permissions:['view']},async()=>count(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${recipient.id} AND role_id LIKE 'compat-grant:%'`),0,1],
   ['delete-grant',{action:'delete-grant',id:assignment},async()=>count(sql`SELECT count(*) AS n FROM role_assignments WHERE id=${assignment}`),1,0],
  ];
  for(const [label,payload,state,before,after] of critical){
   for(const [kind,value] of [['missing',undefined],['garbage','kein-token'],['unknown',token()]]){
    const b=await browser(owner,{proof:false}),auditsBefore=await audits();
    const result=await access(owner,b,value===undefined?payload:{...payload,managementToken:value});
    check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label} ${kind} token: 403 MFA_STEP_UP_REQUIRED`);
    check([await state(),await audits()],[before,auditsBefore],`${label} ${kind} token: nothing changes`);
   }
   const b=await browser(owner),result=await access(owner,b,{...payload,managementToken:b.management});
   check(result.status,200,`${label} with a proof: 200 (${result.body.error})`);check(await state(),after,`${label}: the change happened`);check(await proofExists(b.management),false,`${label}: the proof is consumed`);
   const replay=await access(owner,b,{...payload,managementToken:b.management});check([replay.status,replay.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label}: a used proof is refused`);
  }
 }

 // ---- Removing devices needs a fresh proof, consumed in the removing batch ------
 {
  const removalState=async ids=>({servers:(await d.query(sql`SELECT id,revoked FROM servers WHERE id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY id`)),audit:await count(sql`SELECT count(*) AS n FROM audit WHERE action='Gerät aus Portal entfernt'`),members:await count(sql`SELECT count(*) AS n FROM device_group_members WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`),jobs:await count(sql`SELECT count(*) AS n FROM jobs WHERE state='pending' AND server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`),sessions:await count(sql`SELECT count(*) AS n FROM mfa_sessions`)});
  const fleet=async name=>{const id=await device(name);await insert('device_group_members',{server_id:id,group_id:target});await insert('jobs',{id:uuid(),server_id:id,action:'refresh',target:'',parameters:'{}',state:'pending',created_at:time,actor:owner.id,actor_email:owner.label,actor_principal:owner.principal});return id;};
  const one1=await fleet('SRV-REMOVE-1'),one2=await fleet('SRV-REMOVE-2'),single=await fleet('SRV-REMOVE-3');
  const cases=[['remove-servers',{action:'remove-servers',ids:[one1,one2],confirm:true},[one1,one2]],['remove-server',{action:'remove-server',id:single,confirm:true},[single]]];
  // Broken input gets its 400 before the proof is read. Nothing changes
  // and a supplied valid proof stays usable for a correct removal afterwards.
  {
   const spare=await fleet('SRV-REMOVE-5'),watched=[one1,one2,single,spare];
   const many=Array.from({length:101},()=>uuid());
   const invalid=[
    ['remove-servers ids:[]',{action:'remove-servers',ids:[],confirm:true},serverText('apiError.devices.selectRange')],
    ["remove-servers ids:['x']",{action:'remove-servers',ids:['x'],confirm:true},serverText('apiError.devices.selectRange')],
    ['remove-servers 101 ids',{action:'remove-servers',ids:many,confirm:true},serverText('apiError.devices.selectRange')],
    ['remove-servers without confirm',{action:'remove-servers',ids:[one1]},serverText('apiError.devices.confirmRemoval')],
    ["remove-server id:'x'",{action:'remove-server',id:'x',confirm:true},serverText('apiError.device.invalid')],
    ['remove-server without confirm',{action:'remove-server',id:single},serverText('apiError.devices.confirmRemoval')],
   ];
   for(const [label,payload,expected] of invalid){
    for(const withToken of [false,true]){
     const b=await browser(owner,{proof:withToken}),before=await removalState(watched),auditsBefore=await audits(),proofsBefore=await proofs();
     const result=await removal(owner,b,withToken?{...payload,managementToken:b.management}:payload);
     const how=withToken?'with a valid token':'without a token';
     check([result.status,result.body.error,result.body.code],[400,expected,undefined],`${label} ${how}: 400 before the proof`);
     check(await removalState(watched),before,`${label} ${how}: no device, job, session or membership changes`);
     check([await audits(),await proofs()],[auditsBefore,proofsBefore],`${label} ${how}: no audit row and no proof row change`);
     if(withToken){
      check(await proofExists(b.management),true,`${label}: the valid proof remains`);
      if(label==='remove-server without confirm'){
       const used=await removal(owner,b,{action:'remove-server',id:spare,confirm:true,managementToken:b.management});
       check(used.status,200,`${label}: the same proof then removes a device (${used.body.error})`);check(await proofExists(b.management),false,`${label}: and is consumed`);
      }
     }
    }
   }
   // Valid input: without a token 403 first, an unknown device is 404 only after the proof.
   const unknown=uuid(),bare=await browser(owner,{proof:false});
   const refused=await removal(owner,bare,{action:'remove-server',id:unknown,confirm:true});check([refused.status,refused.body.code],[403,'MFA_STEP_UP_REQUIRED'],'an unknown device without a token: 403 MFA_STEP_UP_REQUIRED');
   const proven=await browser(owner),missing=await removal(owner,proven,{action:'remove-server',id:unknown,confirm:true,managementToken:proven.management});check(missing.status,404,'an unknown device with a proof: 404 as before');
  }
  for(const [label,payload,ids] of cases){
   for(const [kind,value] of [['missing',undefined],['garbage','kein-token'],['unknown',token()],['used',null]]){
    const b=await browser(owner);let supplied=value;
    if(kind==='used'){supplied=b.management;await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${sha(b.management)}`);}
    const before=await removalState(ids);
    const result=await removal(owner,b,supplied===undefined?payload:{...payload,managementToken:supplied});
    check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label} ${kind} token: 403 MFA_STEP_UP_REQUIRED`);
    check(await removalState(ids),before,`${label} ${kind} token: no device, job, session, membership or audit row changes`);
   }
   // The proof disappears right before the batch: nothing is removed.
   {
    const b=await browser(owner),before=await removalState(ids);beforeBatch=()=>d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${sha(b.management)}`);
    const result=await removal(owner,b,{...payload,managementToken:b.management});
    check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label}: a proof that vanishes before the batch is refused`);check(await removalState(ids),before,`${label}: nothing is removed`);
   }
   const b=await browser(owner),result=await removal(owner,b,{...payload,managementToken:b.management});
   check(result.status,200,`${label} with a proof: 200 (${result.body.error})`);
   check((await removalState(ids)).servers.map(row=>row.revoked),ids.map(()=>1),`${label}: the devices are removed`);
   check(await proofExists(b.management),false,`${label}: the proof is consumed`);
   const removing=batches.find(batch=>batch.some(sql=>/^UPDATE servers SET revoked=1/.test(sql)));
   check(removing.some(sql=>/^DELETE FROM mfa_management_proofs WHERE token_hash=\$\d+/.test(sql)),true,`${label}: the removing batch deletes the proof`);
   check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='Gerät aus Portal entfernt' AND target LIKE ${'%'+ids[0]}`),1,`${label}: one audit row per device as before`);
   const again=await removal(owner,b,{...payload,managementToken:b.management});check([again.status,again.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label}: a second request with the same token is refused`);
  }
 }
 // ---- Device moves that widen access need a fresh proof -------
 {
  const reader=await account('reader@stepup.test',['view']),member=await account('member@stepup.test',['view']);
  const role=uuid();await insert('rbac_roles',{id:role,name:'Leser '+role,description:'',permissions:'["view"]',builtin:0,created_at:time});
  const G1=await group('W-G1'),G2=await group('W-G2'),G2a=await group('W-G2a',G2),G3=await group('W-G3');
  await insert('role_assignments',{id:uuid(),principal_type:'user',principal_id:reader.id,role_id:role,scope_type:'devicegroup',scope_id:G2,created_at:time,created_by:'fixture'});
  const userGroup=uuid();await insert('user_groups',{id:userGroup,name:'Team '+userGroup,description:'',enabled:1,created_at:time});await insert('user_group_members',{group_id:userGroup,user_id:member.id});
  await insert('role_assignments',{id:uuid(),principal_type:'group',principal_id:userGroup,role_id:role,scope_type:'devicegroup',scope_id:G3,created_at:time,created_by:'fixture'});
  const E=await device('SRV-E');await insert('device_group_members',{server_id:E,group_id:G2a});
  let serial=0;const fresh=()=>device('SRV-D-'+(++serial));
  // The assigned users each have a live MFA session and an open terminal, which a committed move into their group revokes.
  const seed=async()=>{for(const user of [reader,member]){const at=Date.now();await insert('mfa_sessions',{token_hash:sha(token()),principal:user.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:at+86_400_000});await insert('terminal_sessions',{id:uuid(),server_id:E,principal:user.principal,state:'open',cols:100,rows:30,created_at:at,last_activity:at,expires_at:at+3_600_000});}};
  const state=async()=>{const result={};for(const table of ['device_group_members','audit','mfa_sessions','terminal_sessions','mfa_management_proofs','jobs'])result[table]=(await d.query(sql`SELECT * FROM ${sql.ident(table)}`)).map(row=>JSON.stringify(row)).sort();return result;};
  const widening=[
   ['set-device-memberships into G2 (user assignment)',D=>({action:'set-device-memberships',serverIds:[D],groupId:G2,assigned:true}),G2],
   ['set-device-memberships into G3 (group assignment)',D=>({action:'set-device-memberships',serverIds:[D],groupId:G3,assigned:true}),G3],
   ['update-device-memberships adds into G2',D=>({action:'update-device-memberships',groupId:G2,addIds:[D],removeIds:[]}),G2],
   ['assign-device into G2',D=>({action:'assign-device',serverIds:[D],groupId:G2}),G2],
  ];
  const movedIntoG2=[];
  for(const [label,payload,targetGroup] of widening){
   const D=await fresh();
   // Without a valid proof nothing changes, also not for the assigned users.
   for(const [kind,value] of [['missing',undefined],['garbage','kein-token'],['unknown',token()]]){
    await seed();const b=await browser(owner,{proof:false}),before=await state();
    const result=await access(owner,b,value===undefined?payload(D):{...payload(D),managementToken:value});
    check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label} ${kind} token: 403 MFA_STEP_UP_REQUIRED`);
    if(kind==='missing')check(result.body.error,serverText('apiError.mfa.confirmChange'),`${label}: the existing step-up text`);
    check(await state(),before,`${label} ${kind} token: no membership, audit row, session or terminal changes`);
   }
   // With a valid proof the move commits as today and consumes the proof in its admission batch.
   await seed();const b=await browser(owner),result=await access(owner,b,{...payload(D),managementToken:b.management});
   check(result.status,200,`${label} with a proof: 200 (${result.body.error})`);check(await members(D),[targetGroup],`${label}: the device moved`);
   check(await proofExists(b.management),false,`${label}: the proof is consumed`);
   const committing=batches.find(batch=>batch.some(sql=>/^INSERT INTO audit\(at,actor,action,target\) SELECT/.test(sql)));
   check([/live_proof\.token_hash=\$\d+/.test(committing[0]),committing.some(sql=>/^DELETE FROM mfa_management_proofs WHERE token_hash=\$\d+/.test(sql))],[true,true],`${label}: the proof is part of the audit admission and deleted in the same batch`);
   if(targetGroup===G2)movedIntoG2.push(D);
   // Replay: a second widening request with the same token is refused.
   const other=await fresh(),before=await state(),replay=await access(owner,b,{...payload(other),managementToken:b.management});
   check([replay.status,replay.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label}: a used proof is refused`);check(await state(),before,`${label}: the replay changes nothing`);
  }
  // Moves that do not widen access stay routine: no token, proof rows untouched.
  const D=await fresh();
  const routineMoves=[
   ['an ungrouped device into G1 (no assignment)',{action:'set-device-memberships',serverIds:[D],groupId:G1,assigned:true},async()=>check(await members(D),[G1],'D is in G1')],
   ['E from G2a into G2 (no new assignment)',{action:'set-device-memberships',serverIds:[E],groupId:G2,assigned:true},async()=>check(await members(E),[G2],'E is in G2')],
   ['removal from G2 (assigned:false)',{action:'set-device-memberships',serverIds:[E],groupId:G2,assigned:false},async()=>check(await members(E),[],'E left G2')],
   ['assign-device with groupId:null',{action:'assign-device',serverIds:[movedIntoG2[0]],groupId:null},async()=>check(await members(movedIntoG2[0]),[],'the device is ungrouped')],
   ['update-device-memberships that only removes',{action:'update-device-memberships',groupId:G2,addIds:[],removeIds:[movedIntoG2[1]]},async()=>check(await members(movedIntoG2[1]),[],'the device left G2')],
  ];
  for(const [label,payload,verify] of routineMoves){
   const b=await browser(owner,{proof:false}),proofsBefore=await proofs(),result=await access(owner,b,payload);
   check(result.status,200,`${label}: 200 without managementToken (${result.body.error})`);check(await proofs(),proofsBefore,`${label}: no proof row is deleted`);check(touchesProof(),false,`${label}: no proof row is read or deleted`);await verify();
  }
  // A supplied token on a non-widening move is ignored and its row remains.
  {
   const b=await browser(owner),result=await access(owner,b,{action:'set-device-memberships',serverIds:[D],groupId:G1,assigned:false,managementToken:b.management});
   check(result.status,200,'non-widening removal with a token: 200');check(await proofExists(b.management),true,'non-widening removal: the token row remains');
   const moved=await access(owner,b,{action:'assign-device',serverIds:[D],groupId:G1,managementToken:b.management});
   check(moved.status,200,'non-widening move with a token: 200');check([await proofExists(b.management),touchesProof()],[true,false],'non-widening move: the token is ignored and remains');
  }
  // The rule holds at commit. A devicegroup assignment on the target appears
  // right before the batch of a move read as non-widening: nothing is written.
  for(const [label,scope] of [['on the target',G1],['on an ancestor',null]]){
   const parent=scope??await group('W-Parent'),child=scope?G1:await group('W-Child',parent),moving=await fresh();
   const b=await browser(owner,{proof:false}),before=await state(),assignment=uuid();
   beforeBatch=()=>insert('role_assignments',{id:assignment,principal_type:'user',principal_id:reader.id,role_id:role,scope_type:'devicegroup',scope_id:parent,created_at:time,created_by:'fixture'});
   const result=await access(owner,b,{action:'set-device-memberships',serverIds:[moving],groupId:child,assigned:true});
   check(beforeBatch,null,`${label}: the hook ran right before the batch`);
   check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label}: 403 MFA_STEP_UP_REQUIRED`);
   const after=await state();after.audit=after.audit.filter(row=>!before.audit.includes(row));check([after.device_group_members,after.audit,after.mfa_sessions,after.terminal_sessions],[before.device_group_members,[],before.mfa_sessions,before.terminal_sessions],`${label}: nothing written`);
   await d.exec(sql`DELETE FROM role_assignments WHERE id=${assignment}`);
  }
  // The routes decide by lib/step-up.ts.
  check(/accessActionNeedsStepUpWhenWidening\(p\.action\)/.test(readFileSync('lib/server/identity/access-admin.ts','utf8')),true,'the access module reads the widening classification');
 }
 console.log(`PASS step-up scope (${checks} assertions): routine /api/access changes on the MFA login session behind the session fence, critical access actions, device removal and access-widening device moves on a fresh, consumed step-up proof, one classification in lib/step-up.ts.`);
}finally{d.close();}
