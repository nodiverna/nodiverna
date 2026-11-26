// Reading and changing the usage data decision, against the real
// lib/server/usage-data.ts, route, lib/server/identity/access.ts and runtime/usage-report.mjs on an
// an isolated PostgreSQL test database. The payload is exactly {schema:2,
// instanceId,version,deviceCount}. The flows repeat with only the default
// customer and with a second customer, whose number changes nothing.
// The real switch (usageDataEnabled in runtime/usage-report.mjs) is off: GET says
// enabled:false, an Owner's POST gets 409 without a write, and sendUsageReport
// returns {status:'disabled'} without network or database. The existing flows run
// on a second load of the server module whose import of the switch is stubbed on;
// production code has no test hook. A source guard keeps the switch in one place
// and checks that docs/usage-data.md names only migrations that exist.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';
import * as usageReport from '../../runtime/usage-report.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
import {enableMultipleCustomers,separateCustomers} from '../support/customer-separation.mjs';
const payloadKeys=['schema','instanceId','version','deviceCount'];
const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
try{
 const day=86_400_000,time=Date.now(),clock={now:time},uuid=()=>crypto.randomUUID();
 const version=JSON.parse(readFileSync('package.json','utf8')).version;
 const text={
  ownerOnly:serverText('apiError.settings.ownerOnly'),
  invalid:serverText('apiError.settings.usageInvalid'),
  conflict:serverText('apiError.settings.conflict'),
  unknown:serverText('apiError.request.unknownAction'),unavailable:serverText('apiError.settings.usageUnavailable'),origin:serverText('apiError.request.invalidOrigin'),login:serverText('apiError.auth.loginRequired'),
 };
 const HttpError=realHttpError;
 // The batch hook runs once, right before the next batch.
 let viewer=null,beforeBatch=null;const batches=[],env={SITE_ORIGIN:'https://portal.test',LICENSE_SERVER_URL:''};
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},record:batches});
 const server={db:()=>facade,now:()=>clock.now,config:key=>env[key]??'',HttpError,guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),
  body:request=>request.json(),sameOrigin:request=>{if(request.headers.get('origin')!==env.SITE_ORIGIN)throw new HttpError(403,text.origin);},
  // Each request builds its own viewer, as lib/server/identity/local-auth.ts does.
  requireViewer:async()=>{if(!viewer)throw new HttpError(401,text.login,'IDENTITY_LOGIN_REQUIRED');return {...viewer};},
  failure:error=>Response.json({error:error instanceof HttpError?error.message:serverText('apiError.storageUnavailable'),...(error instanceof HttpError&&error.code?{code:error.code}:{})},{status:error instanceof HttpError?error.status:503,headers:{'Cache-Control':'no-store'}})};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server};
 const load=sourceLoader();
 const usage=load('lib/server/usage-data.ts',imports),route=load('app/api/usage-data/route.ts',imports),usageRoute=route;
 check(usage.usageDataOwnerOnlyMessage,text.ownerOnly);check(usage.usageDataInvalidMessage,text.invalid);check(usage.usageDataConflictMessage,text.conflict);check(usage.usageDataUnavailableMessage,text.unavailable);
 // The same modules once more with the switch stubbed on (only through the loader): the behavior once turned on.
 const onImports={...imports,'../../runtime/usage-report.mjs':{...usageReport,usageDataEnabled:()=>true}};
 const loadOn=sourceLoader();loadOn('lib/server/usage-data.ts',onImports);
 const routeOn=loadOn('app/api/usage-data/route.ts',onImports);

 // ---- Fixture -------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const ownerFixture=await sourceActor(d,'owner@usage.test',['*']),owner=ownerFixture.actor;
 const iam=(await sourceActor(d,'iam@usage.test',['portal.roles.manage','portal.roleAssignments.manage'])).actor;
 const reader=(await sourceActor(d,'reader@usage.test',['view'])).actor;
 for(const [name,revoked] of [['SRV-01',0],['SRV-02',0],['SRV-OLD',1]])await insert('servers',{id:uuid(),name,token_hash:'fixture-'+uuid(),created_at:time,revoked});
 const row=()=>d.query(sql`SELECT * FROM usage_data`).then(results=>({results})).then(result=>{assert.equal(result.results.length,1);return result.results[0];});
 const audit=()=>d.query(sql`SELECT actor,action,target,scope,server_id,customer_id FROM audit ORDER BY id`).then(results=>({results})).then(result=>result.results);
 const instanceId=(await row()).instance_id;
 const call=async(route,who,payload,origin=env.SITE_ORIGIN)=>{
  viewer=who;
  const response=payload===undefined?await route.GET():await route.POST(new Request('https://portal.test/api/usage-data',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(payload)}));
  return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
 };
 // A refused batch (a race) may run; it must not write anything.
 const unchanged=async(label,run,{batch=false}={})=>{const before=[await row(),await audit()],count=batches.length;await run();check([await row(),await audit()],before,label+': nothing written');if(!batch)check(batches.length,count,label+': no batch');};
 const refused=async(result,status,message,label)=>{check([result.status,result.body.error],[status,message],label);};

 // ---- GET -------------------------------------------------------------------------
 {
  const result=await call(route,owner);
  check(result.status,200,'owner GET');check(result.cache,'no-store','GET is not cached');
  check(Object.keys(result.body),['enabled','consent','decidedAt','revision','server','lastAttemptAt','lastSuccessAt','lastError','payload'],'exactly the documented keys, enabled first, no decidedBy');
  check(result.body,{enabled:false,consent:null,decidedAt:null,revision:0,server:'none',lastAttemptAt:null,lastSuccessAt:null,lastError:null,payload:{schema:2,instanceId,version,deviceCount:2}},'fresh installation: off and undecided, revoked devices do not count');
  const on=await call(routeOn,owner);
  check([on.status,Object.keys(on.body)[0],on.body],[200,'enabled',{...result.body,enabled:true}],'switched on: the same view with enabled:true');
  for(const [value,state] of [['','none'],['   ','none'],['http://example.com','invalid'],['https://u:p@example.com','invalid'],['kein-url','invalid'],['https://lizenz.example.com/serverdesk/','configured'],['http://localhost:9000','configured']]){
   env.LICENSE_SERVER_URL=value;
   for(const api of [route,routeOn]){
    const answer=await call(api,owner);
    check([answer.body.enabled,answer.body.server],[api===routeOn,state],`server for "${value}"; a set LICENSE_SERVER_URL does not turn the function on`);
    check(/example[.]com|localhost|lizenz/.test(JSON.stringify(answer.body)),false,'the URL is not in the answer');
   }
  }
  env.LICENSE_SERVER_URL='';
  check(await call(route,null),{status:401,body:{error:text.login,code:'IDENTITY_LOGIN_REQUIRED'},cache:'no-store'},'GET without a session');
 }

 // ---- Not an Owner: 403, nothing written (also IAM administrators) -------------------
 for(const who of [iam,reader])for(const route of [usageRoute,routeOn]){
  await unchanged(who.label,async()=>{
   await refused(await call(route,who),403,text.ownerOnly,who.label+' GET');
   await refused(await call(route,who,{action:'set',enabled:false,revision:0}),403,text.ownerOnly,who.label+' POST');
   await refused(await call(route,who,{action:'set',enabled:true,revision:0}),403,text.ownerOnly,who.label+' POST on');
   // Validation comes first, then the Owner check.
   await refused(await call(route,who,{action:'set',enabled:'ja',revision:0}),400,text.invalid,who.label+' invalid payload');
   await refused(await call(route,who,{action:'remove'}),400,text.unknown,who.label+' unknown action');
  });
 }
 await unchanged('without a session',async()=>{await refused(await call(route,null,{action:'set',enabled:true,revision:0}),401,text.login,'POST without a session');});
 await unchanged('foreign origin',async()=>{await refused(await call(route,owner,{action:'set',enabled:true,revision:0},'https://evil.test'),403,text.origin,'foreign origin');});
 for(const route of [usageRoute,routeOn])await unchanged('invalid payloads',async()=>{
  for(const payload of [{action:'set',enabled:'ja',revision:0},{action:'set',enabled:true,revision:-1},{action:'set',enabled:true,revision:1.5},{action:'set',enabled:true,revision:'0'},{action:'set',enabled:true},{action:'set',enabled:1,revision:0},{action:'set',revision:0}])
   await refused(await call(route,owner,payload),400,text.invalid,JSON.stringify(payload));
  for(const payload of [{action:'activate',enabled:true,revision:0},{enabled:true,revision:0}])await refused(await call(route,owner,payload),400,text.unknown,JSON.stringify(payload));
 });

 // ---- Real switch: off. An Owner's POST gets 409 and writes nothing ----------------------
 check([usageReport.usageDataEnabled(),usageReport.usageDataEnabled({}),usageReport.usageDataEnabled({LICENSE_SERVER_URL:'https://x.example'}),usageReport.usageDataEnabled({LICENSE_SERVER_URL:'http://localhost:9000'})],[false,false,false,false],'usageDataEnabled is false for every env');
 for(const stored of [null,1,0]){
  await d.exec(sql`UPDATE usage_data SET consent=${stored} WHERE id=1`);
  for(const url of ['','https://x.example'])await unchanged(`off, consent ${stored}, url "${url}"`,async()=>{
   env.LICENSE_SERVER_URL=url;
   for(const enabled of [true,false])for(const revision of [0,5]){
    const answer=await call(route,owner,{action:'set',enabled,revision});
    check([answer.status,answer.body,answer.cache],[409,{error:text.unavailable,code:'CONFLICT'},'no-store'],`off: set ${enabled} is refused with 409`);
   }
  });
 }
 env.LICENSE_SERVER_URL='';await d.exec(sql`UPDATE usage_data SET consent=NULL WHERE id=1`);
 // The maintenance report: a valid address, stored consent and a due attempt send nothing.
 {
  await d.exec(sql`UPDATE usage_data SET consent=1,last_attempt_at=NULL WHERE id=1`);
  const requests=[],fetch=async(...args)=>{requests.push(args);return new Response(null,{status:204});};
  const untouchable=new Proxy({},{get:()=>{throw new Error('the database was touched');}});
  const configured={LICENSE_SERVER_URL:'https://x.example'};
  const before=await row();
  check(await usageReport.sendUsageReport(d,{env:configured,fetch,now:time}),{status:'disabled'},'the real switch: disabled');
  check(await usageReport.sendUsageReport(untouchable,{env:configured,fetch,now:time}),{status:'disabled'},'disabled touches no database');
  check(await usageReport.sendUsageReport(untouchable,{env:{LICENSE_SERVER_URL:'kein-url'},fetch,now:time}),{status:'disabled'},'disabled comes before the address check');
  check(await usageReport.sendUsageReport(untouchable,{env:configured,fetch,now:time,enabled:false}),{status:'disabled'},'enabled:false');
  check([requests.length,await row()],[0,before],'no request, the row is unchanged');
  // Switched on (tests only), the same data sends: the existing path is still there.
  check(await usageReport.sendUsageReport(d,{env:configured,fetch,now:time,enabled:true}),{status:'sent'},'enabled:true sends');
  check([requests.length,requests[0][0],JSON.parse(requests[0][1].body)],[1,'https://x.example/v1/usage',{schema:2,instanceId,version,deviceCount:2}],'one request with the payload');
  check(await usageReport.sendUsageReport(untouchable,{env:{},fetch,now:time,enabled:true}),{status:'no-server'},'enabled:true without an address: no-server as before');
  await d.exec(sql`UPDATE usage_data SET consent=NULL,last_attempt_at=NULL,last_success_at=NULL,last_error=NULL WHERE id=1`);
 }

 // ---- Source guard: one switch -------------------------------------------------------------
 {
  const files=execFileSync('git',['ls-files','-co','--exclude-standard','app','ui','lib','runtime','scripts','e2e'],{encoding:'utf8'}).split('\n').filter(name=>/\.(?:ts|tsx|mjs|js)$/.test(name));
  const defining=files.filter(name=>/function usageDataEnabled\b|usageDataEnabled\s*[:=]/.test(readFileSync(name,'utf8')));
  check(defining,['runtime/usage-report.mjs'],'usageDataEnabled is defined only in runtime/usage-report.mjs');
  check(files.filter(name=>name.startsWith('ui/')&&readFileSync(name,'utf8').includes('usageDataEnabled')),[],'ui/ does not reference the switch');
  const server=readFileSync('lib/server/usage-data.ts','utf8'),report=readFileSync('runtime/usage-report.mjs','utf8');
  ok(/import \{[^}]*\busageDataEnabled\b[^}]*\} from '\.\.\/\.\.\/runtime\/usage-report\.mjs'/.test(server)&&/usageDataEnabled\(\{LICENSE_SERVER_URL:config\('LICENSE_SERVER_URL'\)\}\)/.test(server),'lib/server/usage-data.ts calls the switch');
  ok(/enabled = usageDataEnabled\(env\)/.test(report),'sendUsageReport defaults enabled to the switch');
  ok(/export function usageDataEnabled\(env\) \{\s*return false;\s*\}/.test(report),'the switch is off in this version');
  const maintenanceCall=readFileSync('runtime/maintenance.mjs','utf8').match(/sendUsageReport\(database, \{[^}]*\}\)/);
  ok(maintenanceCall&&!/\benabled\b/.test(maintenanceCall[0]),'the maintenance does not pass enabled');
  // docs/usage-data.md names only migrations that exist, and the one that makes the instance ID.
  const doc=readFileSync('docs/usage-data.md','utf8'),migrations=new Set(readdirSync('drizzle'));
  const named=[...new Set(doc.match(/\d{4}_[a-z0-9_]+\.sql/g)??[])];
  check(named.filter(name=>!migrations.has(name)),[],'every migration named in docs/usage-data.md exists in drizzle/');
  ok(named.includes('0000_baseline.sql'),'docs/usage-data.md names the baseline migration');
 }

 // ---- The flows, with one and with several customers ----------------------------------
 async function flows(label,api){
  const start=await row(),entries=(await audit()).length;
  check(start.consent,null,label+': undecided at the start');
  // Agree: one batch with the update and exactly one portal row.
  batches.length=0;clock.now+=1000;
  let result=await call(api,owner,{action:'set',enabled:true,revision:start.revision});
  check([result.status,result.body.consent,result.body.revision,result.body.decidedAt,result.cache],[200,true,start.revision+1,clock.now,'no-store'],label+': enabled');
  check(result.body.payload,{schema:2,instanceId,version,deviceCount:2},label+': the answer carries the payload');
  check(Object.keys(result.body.payload),payloadKeys,label+': exactly the four keys, no edition');
  let current=await row();
  check([current.consent,current.decided_at,current.decided_by,current.revision,current.instance_id],[1,clock.now,owner.principal,start.revision+1,instanceId],label+': stored');
  check(batches.length,1,label+': one batch');check(batches[0].filter(sql=>/^UPDATE usage_data /.test(sql)).length,1,label+': the update');check(batches[0].filter(sql=>/^INSERT INTO audit /.test(sql)).length,1,label+': the audit row is in the same batch');
  check((await audit()).slice(entries),[{actor:owner.label,action:'Datensammlung eingeschaltet',target:'Daten zur Produktverbesserung',scope:'portal',server_id:null,customer_id:null}],label+': one portal row');
  // The same value again: 200 without a write and without audit, also with an old revision.
  await unchanged(label+' same value',async()=>{
   for(const revision of [current.revision,0]){const same=await call(api,owner,{action:'set',enabled:true,revision});check([same.status,same.body.consent,same.body.revision],[200,true,current.revision],label+': same value');}
  });
  // A stale revision: 409, nothing written.
  await unchanged(label+' stale',async()=>{await refused(await call(api,owner,{action:'set',enabled:false,revision:start.revision}),409,text.conflict,label+': stale revision');},{batch:true});
  // Withdraw with one click, no MFA.
  clock.now+=1000;
  result=await call(api,owner,{action:'set',enabled:false,revision:current.revision});
  check([result.status,result.body.consent,result.body.revision],[200,false,current.revision+1],label+': disabled');
  current=await row();check([current.consent,current.decided_at,current.decided_by],[0,clock.now,owner.principal],label+': stored off');
  check((await audit()).slice(entries+1),[{actor:owner.label,action:'Datensammlung ausgeschaltet',target:'Daten zur Produktverbesserung',scope:'portal',server_id:null,customer_id:null}],label+': off audit row');
  // Race: the Owner right disappears between the check and the commit.
  beforeBatch=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${ownerFixture.assignmentId}`);
  await unchanged(label+' owner race',async()=>{await refused(await call(api,owner,{action:'set',enabled:true,revision:current.revision}),403,text.ownerOnly,label+': Owner right revoked before the commit');},{batch:true});
  await insert('role_assignments',{id:ownerFixture.assignmentId,principal_type:'user',principal_id:owner.id,role_id:ownerFixture.roleId,scope_type:'global',scope_id:'*',created_at:time,created_by:owner.principal});
  // Race: another Owner decided between the check and the commit.
  beforeBatch=()=>d.exec(sql`UPDATE usage_data SET revision=revision+1 WHERE id=1`);
  const raceStart=(await audit()).length;batches.length=0;
  await refused(await call(api,owner,{action:'set',enabled:true,revision:current.revision}),409,text.conflict,label+': revision changed before the commit');
  check([(await row()).consent,(await audit()).length],[0,raceStart],label+': the conflicting batch wrote nothing');
  // Back to undecided for the next phase (only a test can do that).
  await d.exec(sql`UPDATE usage_data SET consent=NULL,decided_at=NULL,decided_by=NULL WHERE id=1`);
 }
 // Phase 1: only the default customer.
 check(Number((await d.one(sql`SELECT count(*) AS n FROM customers`)).n),1,'phase 1 has one customer');
 await flows('one customer',routeOn);
 await insert('servers',{id:uuid(),name:'SRV-03',token_hash:'fixture-'+uuid(),created_at:time,revoked:1});
 // Phase 2: a second customer, and a later clock.
 await d.exec(enableMultipleCustomers());await d.exec(separateCustomers(time-day));
 clock.now=time+61*day;
 await flows('several customers',routeOn);

 console.log(`PASS: ${checks} usage data assertions: the switch off (GET enabled:false, 409 without a write, no report), Owner-only GET and POST, validation order, audit in the same batch, conflicts and races, the payload with exactly four keys, with one and with several customers.`);
}finally{d.close();}
