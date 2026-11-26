// Release catalog lifecycle/view regressions supersede the removed campaign UI.
// Dev builds (X.Y.Z-dev.<sha7>): the catalog marks dev and never makes one latest, the bootstrap and the EXE
// download never serve one, a dev build is always deactivatable, GET answers devBuilds, a deploy of a dev build
// needs Import dev builds and follows the rank rules, and the devBuilds action is Owner only with MFA and audit.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';
import {releaseChunkKey} from '../../runtime/release-import.mjs';
import {createStorage} from '../../runtime/storage.mjs';
import {validateReleaseChangelog} from '../../scripts/release-changelog.mjs';
import {sourceLoader,sourceDatabase,dbModule} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {i18nRequire} from '../support/i18n-stubs.mjs';
import {serverDeskRoot} from '../support/paths.mjs';
const root=serverDeskRoot;
const require=createRequire(import.meta.url),publisher=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jobSigner=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'}),origin='https://release.test';
const HttpError=realHttpError;
const compiled=new Map();
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
// Loads a source file with the given modules. Any other relative or '@/'
// import loads its real source with the same modules (a module '@/lib/x' also
// replaces './x'); the data layer is the shared lib/server/db.ts.
async function load(file,modules){return loadSync(path.join(root,file),modules,new Map());}
function loadSync(absolute,modules,loaded){
 if(loaded.has(absolute))return loaded.get(absolute).exports;
 let code=compiled.get(absolute);if(!code){code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;compiled.set(absolute,code);}
 const state={exports:{}};loaded.set(absolute,state);
 new Function('require','module','exports',code)(name=>{
  if(Object.hasOwn(modules,name))return modules[name];
  const stub=i18nRequire(name);if(stub)return stub;
  if(name==='./db'||name==='../db'||name==='../../db')return dbModule();
  if(name.startsWith('.')||name.startsWith('@/')){
   const base=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(absolute),name),target=[base,base+'.ts',path.join(base,'index.ts')].find(candidate=>existsSync(candidate)&&statSync(candidate).isFile());
   if(target){
    const alias='@/'+path.relative(root,target).split(path.sep).join('/').replace(/[.](?:ts|mts)$/,'').replace(/[/]index$/,'');
    if(Object.hasOwn(modules,alias))return modules[alias];
    return /[.](?:m?js|json)$/.test(target)?require(target):loadSync(target,modules,loaded);
   }
  }
  return require(name);
 },state,state.exports);return state.exports;
}
/**
 * A release as the import stores it: a signed path-form manifest over real
 * bytes. The EXE file row has two chunks, so a download reads them in order.
 */
function release(version,createdAt=Date.now(),changelog){
 const zip=Buffer.from(`zip of ${version} `.repeat(7)),exe=Buffer.from(`exe of ${version} `.repeat(11)),half=Math.floor(exe.length/2),exeChunks=[exe.subarray(0,half),exe.subarray(half)];
 const manifest=JSON.stringify({version,protocolVersion:3,minProtocolVersion:3,os:['Windows 11 Pro'],arch:'x64',path:`/downloads/agent-${version}.zip`,sha256:sha256(zip),size:zip.length,layout:'single-exe',exe:{path:`/downloads/agent-${version}.exe`,sha256:sha256(exe),size:exe.length},...(changelog?{changelog}:{}),createdAt:new Date(createdAt).toISOString()});
 return {id:randomUUID(),version,manifest,signature:sign('sha256',Buffer.from(manifest),publisher.privateKey).toString('base64'),sha256:sha256(zip),size:zip.length,createdAt,bytes:{zip,exe,exeChunks}};
}
async function fixture(run){
 const database=await sourceDatabase(),directory=mkdtempSync(path.join(os.tmpdir(),'sd-release-lifecycle-'));
 const storage=createStorage({OBJECT_STORAGE_DRIVER:'filesystem',OBJECT_STORAGE_PATH:path.join(directory,'objects')});
 let beforeBatch,beforeStatement,clock=Date.now(),owner=true;
 // beforeBatch runs once before the next transaction, beforeStatement once
 // before the next standalone statement it matches.
 const wrapped=hookDatabase(database,{
  transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},
  statement:async(text,kind,inTransaction)=>{if(!inTransaction&&beforeStatement&&beforeStatement.match(text)){const hook=beforeStatement;beforeStatement=null;await hook.run();}},
 });
 const settings={SITE_ORIGIN:origin,AGENT_JOB_SIGNING_KEY:jobSigner};
 const server={db:()=>wrapped,HttpError,now:()=>clock,config:key=>settings[key]??'',sameOrigin:()=>{},requireViewer:async()=>({id:'owner',label:'owner@example.test',permissions:owner?['*']:[]}),body:request=>request.json(),guid:value=>typeof value==='string'&&/^[\da-f-]{36}$/.test(value),log:async()=>{},failure:error=>Response.json({error:error.message,messageKey:error.messageKey,params:error.params},{status:error.status??503,headers:{'Cache-Control':'no-store'}})};
 const app=await load('lib/server/agent/releases.ts',{'../context':server,'../../release-publisher.json':{publicKey:publisher.publicKey.export({format:'pem',type:'spki'})}});
 const serverId=randomUUID(),snapshot={protocolVersion:3,agentVersion:'4.7.0',mode:'Management',os:'Microsoft Windows 11 Pro',agentCapabilities:['agent-update','release-paths']},device={id:serverId,name:'HOST',revoked:0,management:1,snapshot:JSON.stringify(snapshot)};
 await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,snapshot,management) VALUES(${serverId},${device.name},${'fixture'}, ${clock},${device.snapshot},1)`);
 // The release row, its file rows and its chunks, as runtime/release-import.mjs writes them.
 const save=async item=>{
  await database.exec(sql`INSERT INTO agent_releases(id,version,manifest,signature,sha256,size,created_at) VALUES(${item.id},${item.version},${item.manifest},${item.signature},${item.sha256},${item.size},${item.createdAt})`);
  const manifest=JSON.parse(item.manifest),chunk=bytes=>({sha256:sha256(bytes),size:bytes.length});
  for(const bytes of [item.bytes.zip,...item.bytes.exeChunks])await storage.put(releaseChunkKey(sha256(bytes)),bytes);
  for(const [entry,chunks] of [[manifest,[chunk(item.bytes.zip)]],[manifest.exe,item.bytes.exeChunks.map(chunk)]])await database.exec(sql`INSERT INTO agent_release_files(release_id,path,size,sha256,chunks) VALUES(${item.id},${entry.path},${entry.size},${entry.sha256},${JSON.stringify(chunks)})`);
 };
 const latest=release('4.9.0',clock-10000),old=release('4.8.0',clock-5000,{features:['Neue Agentfunktion'],fixes:['Verbindungsfehler korrigiert']});
 await save(latest);await save(old);
 const queue=async(state='pending')=>{const id=randomUUID();await database.exec(sql`INSERT INTO jobs(id,server_id,action,target,parameters,state,created_at,actor,actor_email,actor_principal) VALUES(${id},${serverId},'agent-update',${old.version},${JSON.stringify({releaseId:old.id,manifest:old.manifest,signature:old.signature})},${state},${clock},${'owner'},${'owner@example.test'},${'private:owner@example.test'})`);return id;};
 try{await run({database,wrapped,app,old,latest,server,settings,serverId,device,snapshot,save,queue,storage,guard:sql`TRUE`,setBatch:hook=>{beforeBatch=hook;},setStatement:hook=>{beforeStatement=hook;},setOwner:value=>{owner=value;},tick:(ms=1000)=>clock+=ms});}finally{await database.close();rmSync(directory,{recursive:true,force:true});}
}

test('release catalog marks highest version Latest and exposes only publisher-signed notes',async()=>fixture(async({app,old,latest})=>{
 const catalog=await app.releases();assert.equal(catalog[0].id,latest.id);assert.equal(catalog[0].latest,true);assert.equal(catalog[1].latest,false);assert.equal(catalog[1].active,true);assert.deepEqual(catalog[1].changelog,{features:['Neue Agentfunktion'],fixes:['Verbindungsfehler korrigiert']});assert.equal(catalog[0].changelog,null);
 assert.equal('legacyForm' in catalog[0],false,'catalog items have no legacy form');
 assert.throws(()=>app.verifiedRelease(old.manifest.replace('Verbindungsfehler','Installationsfehler'),old.signature),{status:400,messageKey:'apiError.release.signatureInvalid'});
 await assert.rejects(app.retireRelease(latest.id,'disable','owner',sql`TRUE`),error=>error.status===409);
}));

test('disable cancels queued updates, preserves running signed envelopes; a deleted release is not found',async()=>fixture(async({app,database,old,queue,guard})=>{
 const queued=await queue(),running=await queue('running'),runningBefore=await database.one(sql`SELECT parameters FROM jobs WHERE id=${running}`);
 const result=await app.retireRelease(old.id,'disable','owner',guard);assert.equal(result.cancelledJobs,1);assert.deepEqual(await database.one(sql`SELECT state,parameters FROM jobs WHERE id=${queued}`),{state:'cancelled',parameters:'{}'});assert.deepEqual(await database.one(sql`SELECT parameters FROM jobs WHERE id=${running}`),runningBefore);
 assert.equal((await app.releases()).find(item=>item.id===old.id).active,false);await assert.rejects(app.releaseById(old.id),error=>error.status===410&&error.messageKey==='apiError.release.disabled');
 await assert.rejects(app.retireRelease(old.id,'delete','owner',guard),error=>error.status===409);assert.equal((await database.one(sql`SELECT state FROM agent_release_states WHERE release_id=${old.id}`)).state,'disabled');
 await database.exec(sql`UPDATE jobs SET state='succeeded' WHERE id=${running}`);await app.retireRelease(old.id,'delete','owner',guard);assert.ok(!(await app.releases()).some(item=>item.id===old.id));await assert.rejects(app.releaseById(old.id),error=>error.status===404&&error.messageKey==='apiError.release.notFound');assert.equal((await database.one(sql`SELECT signature FROM agent_releases WHERE id=${old.id}`)).signature,old.signature);
}));

test('release management rechecks live authorization without partial queued-job cancellation',async()=>fixture(async({app,database,old,queue,setBatch})=>{
 await database.exec(sql`CREATE TABLE lifecycle_actor(enabled INTEGER)`);await database.exec(sql`INSERT INTO lifecycle_actor VALUES(1)`);const id=await queue();
 setBatch(()=>database.exec(sql`UPDATE lifecycle_actor SET enabled=0`));await assert.rejects(app.retireRelease(old.id,'disable','owner',sql`EXISTS(SELECT 1 FROM lifecycle_actor WHERE enabled=1)`),error=>error.status===409);
 assert.equal(await database.one(sql`SELECT release_id FROM agent_release_states WHERE release_id=${old.id}`),null);assert.equal((await database.one(sql`SELECT state FROM jobs WHERE id=${id}`)).state,'pending');
}));

// policy replaces the stub of @/lib/server/identity/policy/can (the demoted Owner case).
async function releaseApi(context,proofs=[],policy,mfa){
 const versions=await load('lib/agent-update-state.ts',{'../ui/base/access-capabilities':await load('ui/base/access-capabilities.ts',{})});
 // The deploy looks up the target customers through the real core module (single customer here).
 const crossCustomer=await load('lib/server/identity/cross-customer.ts',{'../context':context.server});
 return load('app/api/releases/route.ts',{'@/lib/server/context':context.server,'@/lib/server/identity/access':{requireDevice:async(_viewer,id)=>context.devices?.get(id)??context.device,allowedDeviceIds:async()=>[context.serverId],principal:v=>v.principal??'private:'+v.label},'@/lib/server/identity/feature-authorization':{featureTargetsGuard:()=>(sql`TRUE`)},'@/lib/server/identity/policy/can':policy??{can:async v=>v.permissions.includes('*'),requireCan:async v=>{if(!v.permissions.includes('*'))throw new HttpError(403,serverText('apiError.policy.permissionMissing'));},viewerCanSql:()=>context.guard},'@/lib/server/identity/mfa':mfa??{requireMfa:async()=>{},mfaSessionFence:async()=>sql`TRUE`,requireLiveSessions:async()=>{}},'cloudflare:workers':{env:{}},'@/lib/server/agent/agent-protocol':{modern:device=>device.snapshot?JSON.parse(device.snapshot):context.snapshot,maintenanceBusy:async()=>false},'@/lib/server/agent/releases':context.app,'@/lib/server/devices/rdp':{sweepRdp:async()=>{}},'@/lib/agent-update-state':versions,'@/lib/server/identity/cross-customer':crossCustomer,
  // No release action reads a step-up proof; the spy records any read (deploy and the retired token actions read none).
  '@/lib/server/identity/rbac':{prepareManagementAuthorization:async(_request,_viewer,value)=>{proofs.push(value);return {guard:sql`TRUE`,tokenHash:'fixture-proof',key:'fixture',sessionHash:'fixture'};}},'@/lib/step-up':await load('lib/step-up.ts',{})});
}
const request=payload=>new Request(origin+'/api/releases',{method:'POST',body:JSON.stringify(payload)});
test('deploy refuses deactivation between preflight and admission and keeps lifecycle admin only',async()=>fixture(async context=>{
 const api=await releaseApi(context);context.setBatch(()=>context.database.exec(sql`INSERT INTO agent_release_states VALUES(${context.old.id},'disabled',${Date.now()},'owner')`));
 const result=await api.POST(request({action:'deploy',releaseId:context.old.id,serverIds:[context.serverId],confirm:true}));assert.equal(result.status,409);assert.equal((await result.json()).messageKey,'apiError.release.rolloutChanged');assert.equal((await context.database.one(sql`SELECT count(*) AS count FROM jobs`)).count,0);
 context.setOwner(false);const denied=await api.POST(request({action:'delete',releaseId:context.old.id,confirm:true}));assert.equal(denied.status,403);
}));

async function channel(context){
 const noop=async()=>{},no=()=>false;
 return load('app/api/agent/channel/route.ts',{'@/lib/server/context':context.server,'@/lib/server/agent/agent-dispatch':await load('lib/server/agent/agent-dispatch.ts',{}),'@/lib/server/agent/agent-protocol':{agentFromBearer:async()=>context.device,assertAgentActive:noop,snapshot:()=>context.snapshot,releaseLease:noop,securityFile:no,lease:noop},'@/lib/server/identity/access':{resolvePrincipal:async()=>({id:'owner'}),requireDevice:noop,devicePermissionGuard:()=>(sql`TRUE`)},'@/lib/jobs/requirements':sourceLoader()('lib/jobs/requirements.ts'),'@/lib/server/devices/file-access':{requireFileAccess:noop},'@/lib/server/automation/runbooks':{tickAutomation:noop},'@/lib/server/automation/drift':{getDriftPolicy:async()=>null,ingestDrift:noop},'@/lib/server/devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>(sql`TRUE`)},'@/lib/server/devices/terminal-lifecycle':{sweepTerminalSessions:noop},'@/lib/server/devices/rdp':{sweepRdp:noop},'@/lib/server/devices/terminal-channel':{terminalReport:(await import('zod')).z.object({}),exchangeTerminals:async()=>[]},'@/lib/server/automation/desired-state':{advanceDesiredState:noop,checkPendingDesiredJob:async()=>true},'@/lib/server/automation/desired-state-result':await load('lib/server/automation/desired-state-result.ts',{}),'@/lib/server/automation/automation-device':{reconcileDeviceAutomation:noop,getAutomationDriftPolicy:async()=>({enabled:false})},'@/lib/job-expiry':await load('lib/job-expiry.ts',{}),'@/lib/agent-messages':await load('lib/agent-messages.ts',{'./i18n/messages/en':await load('lib/i18n/messages/en.ts',{})})});
}
test('agent dispatch rechecks a release after claiming and never sends a disabled signed envelope',async()=>fixture(async context=>{
 const id=await context.queue(),api=await channel(context);
 context.setStatement({match:sql=>sql.startsWith('SELECT id,action,target,parameters,created_at AS "createdAt" FROM jobs WHERE id='),run:()=>context.database.exec(sql`INSERT INTO agent_release_states VALUES(${context.old.id},'disabled',${Date.now()},'owner')`)});
 const response=await api.POST(request({serverId:context.serverId}));assert.equal(response.status,200);const dispatched=await response.json();assert.deepEqual(dispatched.jobs,[]);assert.deepEqual(dispatched.signedJobs,[],'no signed envelope for the cancelled job either');assert.equal((await context.database.one(sql`SELECT state FROM jobs WHERE id=${id}`)).state,'cancelled');
}));

test('future publishing requires bounded, version-specific changelog entries',()=>{
 assert.deepEqual(validateReleaseChangelog({version:'4.10.0',features:[' New capability '],fixes:[]},'4.10.0'),{features:['New capability'],fixes:[]});
 for(const notes of [{version:'4.9.0',features:['Feature'],fixes:[]},{version:'4.10.0',features:[],fixes:[]},{version:'4.10.0',features:['x'.repeat(201)],fixes:[]},{version:'4.10.0',features:['x'],fixes:[],untrusted:true}])assert.throws(()=>validateReleaseChangelog(notes,'4.10.0'));
});

// ---- Serving the newest release --------------------------------------------------
async function routes(context){
 const releaseSource=await load('lib/server/agent/release-source.ts',{'cloudflare:workers':{env:{BUCKET:context.storage}},'../context':context.server,'./context':context.server});
 const download=await load('lib/server/agent/agent-download.ts',{'./releases':context.app,'../context':context.server,'./release-source':releaseSource});
 return {
  bootstrap:await load('app/Agent-v3-release.json/route.ts',{'@/lib/server/agent/releases':context.app,'@/lib/server/context':context.server}),
  download:await load('app/api/agent/download/route.ts',{'@/lib/server/context':context.server,'@/lib/server/agent/agent-download':download,'@/lib/server/identity/policy/can':{requireCan:async()=>{}}}),
  files:await load('app/downloads/[file]/route.ts',{'@/lib/server/agent/release-source':releaseSource,'@/lib/server/context':context.server}),
 };
}
const read=async response=>({status:response.status,headers:response.headers,body:await response.json()});
test('the bootstrap route answers with the exact envelope of the latest release, ignores form and skips disabled and deleted releases',async()=>fixture(async context=>{
 const {bootstrap}=await routes(context),get=query=>bootstrap.GET(new Request(origin+'/Agent-v3-release.json'+query));
 for(const query of ['','?form=path','?form=url','?form=PATH']){
  const answer=await read(await get(query));
  assert.equal(answer.status,200,query);assert.deepEqual(answer.body,{manifest:context.latest.manifest,signature:context.latest.signature},query);
  for(const [header,value] of [['cache-control','no-store'],['content-type','application/json; charset=utf-8'],['x-content-type-options','nosniff']])assert.equal(answer.headers.get(header),value,`${query} ${header}`);
 }
 // A disabled highest version is not the latest: the next active release is served (after the 30 s cache).
 await context.database.exec(sql`INSERT INTO agent_release_states VALUES(${context.latest.id},'disabled',${Date.now()},'owner')`);
 context.tick(30000);
 assert.equal((await read(await get(''))).body.manifest,context.old.manifest);
 await context.database.exec(sql`INSERT INTO agent_release_states VALUES(${context.old.id},'deleted',${Date.now()},'owner')`);
 context.tick(30000);
 const none=await read(await get('?form=path'));
 assert.deepEqual([none.status,none.body.messageKey,none.headers.get('cache-control')],[404,'apiError.release.noneAvailable','no-store'],'without a latest release');
}));

test('the bootstrap route reads the catalog at most once per 30 s: concurrent requests share one read, no release is cached, a failed read is not, and the Owner download stays uncached',async()=>fixture(async context=>{
 // Counts the catalog reads (the release rows of releases()); a failure can be injected into the next read.
 let reads=0,breakNext=false;
 hookDatabase(context.database,{statement:async text=>{if(/FROM agent_releases r WHERE NOT EXISTS/.test(text)){reads++;if(breakNext){breakNext=false;throw new Error('the database is not reachable');}}}});
 const {bootstrap,download}=await routes(context),get=()=>bootstrap.GET(new Request(origin+'/Agent-v3-release.json'));
 const envelope=release=>({manifest:release.manifest,signature:release.signature});
 const headers=answer=>['cache-control','content-type','x-content-type-options'].map(header=>answer.headers.get(header));
 // 5 concurrent and 3 sequential requests within 30 s: one read, the same exact answer.
 const concurrent=await Promise.all(Array.from({length:5},async()=>read(await get())));
 const sequential=[];for(let n=0;n<3;n++){context.tick(9000);sequential.push(await read(await get()));}
 assert.equal(reads,1,'one catalog read within the TTL');
 for(const answer of [...concurrent,...sequential]){assert.equal(answer.status,200);assert.deepEqual(answer.body,envelope(context.latest));assert.deepEqual(headers(answer),['no-store','application/json; charset=utf-8','nosniff']);}
 // A release imported meanwhile is served once the 30 s are over.
 const newer=release('4.10.0',Date.now());await context.save(newer);
 assert.deepEqual((await read(await get())).body,envelope(context.latest),'within the TTL the cached release');
 context.tick(3001);
 assert.deepEqual((await read(await get())).body,envelope(newer),'after the TTL the new release');
 assert.equal(reads,2);
 // The other callers of latestRelease() are not cached: the Owner download reads the catalog itself.
 await download.GET();assert.equal(reads,3,'the Owner download is not cached');
 // A failed read answers an error and is not cached: the next request reads again.
 context.tick(30000);breakNext=true;
 const failed=await get();assert.equal(failed.status,503);assert.equal(failed.headers.get('cache-control'),'no-store');
 assert.equal(reads,4);
 assert.deepEqual((await read(await get())).body,envelope(newer),'the next request reads again');
 assert.equal(reads,5);
 // No release: 404, cached for 30 s, then 200 once a release exists.
 await context.database.exec(sql`INSERT INTO agent_release_states SELECT id,'deleted',${Date.now()},'owner' FROM agent_releases`);
 context.tick(30000);
 const none=await read(await get());assert.deepEqual([none.status,none.body.messageKey,none.headers.get('cache-control')],[404,'apiError.release.noneAvailable','no-store']);
 const back=release('4.11.0',Date.now());await context.save(back);
 assert.equal((await read(await get())).status,404,'no release is cached too');
 assert.equal(reads,6);
 context.tick(30000);
 const found=await read(await get());assert.deepEqual([found.status,found.body],[200,envelope(back)]);
 assert.equal(reads,7);
}));

test('the Owner download streams the EXE of the latest release from its chunks with the signed SHA-256 and aborts on a wrong chunk',async()=>fixture(async context=>{
 const {download}=await routes(context),{exe,exeChunks}=context.latest.bytes,manifest=JSON.parse(context.latest.manifest);
 const response=await download.GET();
 assert.equal(response.status,200);
 for(const [header,value] of [['content-type','application/octet-stream'],['content-length',String(exe.length)],['content-disposition','attachment; filename="ServerDesk.Agent.exe"'],['cache-control','no-store'],['x-content-type-options','nosniff'],['x-agent-version','4.9.0'],['x-agent-sha256',manifest.exe.sha256],['x-agent-size',String(exe.length)]])assert.equal(response.headers.get(header),value,header);
 const body=Buffer.from(await response.arrayBuffer());
 assert.ok(body.equals(exe),'the whole EXE, its chunks in order');assert.equal(sha256(body),manifest.exe.sha256);
 // A changed chunk of the same length aborts the stream.
 const corrupt=Buffer.from(exeChunks[1]);corrupt[0]^=1;await context.storage.put(releaseChunkKey(sha256(exeChunks[1])),corrupt);
 await assert.rejects((await download.GET()).arrayBuffer());
 await context.storage.delete(releaseChunkKey(sha256(exeChunks[0])));
 await assert.rejects((await download.GET()).arrayBuffer(),/missing/);
 // Without a latest release: 404 noneAvailable.
 await context.database.exec(sql`INSERT INTO agent_release_states VALUES(${context.latest.id},'deleted',${Date.now()},'owner'),(${context.old.id},'disabled',${Date.now()},'owner')`);
 const none=await read(await download.GET());assert.deepEqual([none.status,none.body.messageKey],[404,'apiError.release.noneAvailable']);
}));

test('GET /downloads serves only files of stored releases that are not deleted',async()=>fixture(async context=>{
 const {files}=await routes(context),get=file=>files.GET(new Request(`${origin}/downloads/${file}`),{params:Promise.resolve({file})});
 const zip=await get('agent-4.8.0.zip');assert.equal(zip.status,200);assert.ok(Buffer.from(await zip.arrayBuffer()).equals(context.old.bytes.zip));
 await context.database.exec(sql`INSERT INTO agent_release_states VALUES(${context.old.id},'disabled',${Date.now()},'owner')`);
 assert.equal((await get('agent-4.8.0.exe')).status,200,'a disabled release still serves dispatched updates');
 await context.database.exec(sql`UPDATE agent_release_states SET state='deleted' WHERE release_id=${context.old.id}`);
 for(const file of ['agent-4.8.0.zip','agent-4.8.0.exe','ServerDesk-Agent-4.7.3-win-x64.exe','agent.exe']){const answer=await read(await get(file));assert.deepEqual([answer.status,answer.body.messageKey],[404,'apiError.download.fileNotFound'],file);}
}));

// ---- Deploy: one path envelope -----------------------------------------------------
async function secondDevice(context,capabilities){
 const id=randomUUID(),snapshot={...context.snapshot,agentCapabilities:capabilities},device={id,name:'OLD-HOST',revoked:0,management:1,snapshot:JSON.stringify(snapshot)};
 await context.database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,snapshot,management) VALUES(${id},${device.name},${'fixture-2'},${Date.now()},${device.snapshot},1)`);
 return device;
}
test('deploy gives every device the exact signed path envelope and refuses a device without release-paths before any write',async()=>fixture(async context=>{
 const older=await secondDevice(context,['agent-update']);
 context.devices=new Map([[context.device.id,context.device],[older.id,older]]);
 const proofs=[],api=await releaseApi(context,proofs),deploy=serverIds=>api.POST(request({action:'deploy',releaseId:context.latest.id,serverIds,confirm:true}));
 const count=async()=>Number((await context.database.one(sql`SELECT count(*) AS count FROM jobs`)).count);
 const refused=await deploy([context.device.id,older.id]);
 assert.equal(refused.status,409);const body=await refused.json();
 assert.equal(body.messageKey,'apiError.release.legacyFormUnavailable');assert.deepEqual(body.params,{name:'OLD-HOST'});
 assert.equal(body.error,serverText('apiError.release.legacyFormUnavailable',{name:'OLD-HOST'}));
 assert.equal(await count(),0,'no job of the request is written');
 const accepted=await deploy([context.device.id]);assert.equal(accepted.status,200,await accepted.clone().text());
 const job=await context.database.one(sql`SELECT parameters FROM jobs WHERE server_id=${context.device.id}`);
 assert.deepEqual(JSON.parse(job.parameters),{releaseId:context.latest.id,manifest:context.latest.manifest,signature:context.latest.signature},'the exact signed path-form envelope');
 assert.equal(proofs.length,0,'deploy relies on the MFA login session and reads no step-up proof');
}));

test('the record-only import action is gone: it answers like an unknown action and writes no release',async()=>fixture(async context=>{
 const api=await releaseApi(context),imported=release('4.11.0');
 const before=Number((await context.database.one(sql`SELECT count(*) AS n FROM agent_releases`)).n);
 const answers=[];
 for(const payload of [{action:'import',manifest:imported.manifest,signature:imported.signature},{action:'bogus',manifest:imported.manifest,signature:imported.signature}]){const response=await api.POST(request(payload));answers.push([response.status,(await response.json()).messageKey]);}
 assert.deepEqual(answers[0],answers[1],'import answers like an unknown action');
 assert.deepEqual(answers[0],[400,'apiError.release.pilotDevicesRequired']);
 assert.equal(Number((await context.database.one(sql`SELECT count(*) AS n FROM agent_releases`)).n),before,'no release row is written');
}));

test('a stored row without its file rows or with an absolute-form manifest is not in the catalog and not found',async()=>fixture(async context=>{
 const orphan=release('4.12.0');
 await context.database.exec(sql`INSERT INTO agent_releases(id,version,manifest,signature,sha256,size,created_at) VALUES(${orphan.id},${orphan.version},${orphan.manifest},${orphan.signature},${orphan.sha256},${orphan.size},${orphan.createdAt})`);
 assert.ok(!(await context.app.releases()).some(item=>item.id===orphan.id));
 await assert.rejects(context.app.releaseEnvelopes(orphan.id),{messageKey:'apiError.release.notFound'});
 const absolute=orphan.manifest.replace(`"path":"/downloads/agent-4.12.0.zip"`,`"url":"${origin}/downloads/agent-4.12.0.zip"`).replace(`"path":"/downloads/agent-4.12.0.exe"`,`"url":"${origin}/downloads/agent-4.12.0.exe"`);
 assert.throws(()=>context.app.verifiedRelease(absolute,sign('sha256',Buffer.from(absolute),publisher.privateKey).toString('base64')),{messageKey:'apiError.release.invalidReleaseManifest'});
}));

// ---- Release source (lib/server/agent/release-source.ts) -------------------------------------
test('release source: check is Owner only and writes an audit row, set-token and remove-token answer like an unknown action and change nothing, only Owners get source, and a stored bare reason comes back as its key',async()=>fixture(async context=>{
 const proofs=[],api=await releaseApi(context,proofs),token='github_pat_'+'Z9y8'.repeat(8);
 const json=async response=>({status:response.status,body:await response.json()});
 let answer=await json(await api.GET());
 // history: the bundled changelogs of every agent version, newest first, for every release viewer.
 const history=JSON.parse(readFileSync(path.join(root,'lib','agent-changelog-history.json'),'utf8'));
 assert.ok(Array.isArray(answer.body.history)&&answer.body.history.length>0);assert.deepEqual(answer.body.history,history);
 assert.deepEqual(answer.body.history.map(entry=>entry.version),[...answer.body.history.map(entry=>entry.version)].sort((x,y)=>{const [p,q]=[x.split('.').map(Number),y.split('.').map(Number)];return q[0]-p[0]||q[1]-p[1]||q[2]-p[2];}),'newest first');
 assert.deepEqual(Object.keys(answer.body).sort(),['campaigns','devBuilds','history','releases','source']);
 assert.deepEqual(answer.body.source,{repository:'nodiverna/nodiverna',state:'idle',lastStartedAt:null,lastFinishedAt:null,lastError:null,devBuilds:false,imports:[]},'the view has no token fields');
 answer=await json(await api.POST(request({action:'check'})));
 assert.deepEqual([answer.status,answer.body.source.state,proofs.length],[200,'queued',0],'check needs no step-up and queues a check');
 assert.deepEqual(Object.keys(answer.body.source).sort(),['devBuilds','imports','lastError','lastFinishedAt','lastStartedAt','repository','state'],'the check answer has no token fields');
 const requested=(await context.database.one(sql`SELECT requested_at FROM agent_release_source WHERE id=1`)).requested_at;
 const checks=async()=>(await context.database.query(sql`SELECT actor,action,target,scope,server_id FROM audit WHERE action='Agent release check requested'`));
 assert.deepEqual(await checks(),[{actor:'owner@example.test',action:'Agent release check requested',target:'Agent releases',scope:'portal',server_id:null}],'check writes one audit row');
 context.tick();answer=await json(await api.POST(request({action:'check'})));
 assert.deepEqual([answer.status,answer.body.source.state],[200,'queued'],'a second check while queued answers the unchanged view');
 assert.equal((await context.database.one(sql`SELECT requested_at FROM agent_release_source WHERE id=1`)).requested_at,requested,'nothing changes while a check is queued');
 assert.equal((await checks()).length,1,'a second check while queued writes no audit row');
 // The retired token actions: the answer of an unknown action, no row, audit or proof change.
 await context.database.exec(sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES('fixture-proof','fixture','fixture',${Date.now()+60000})`);
 const row=async()=>context.database.one(sql`SELECT * FROM agent_release_source WHERE id=1`),auditCount=async()=>Number((await context.database.one(sql`SELECT count(*) AS n FROM audit`)).n),proofRows=async()=>Number((await context.database.one(sql`SELECT count(*) AS n FROM mfa_management_proofs`)).n);
 const before=[await row(),await auditCount(),await proofRows()];
 const unknown=await json(await api.POST(request({action:'rotate-everything'})));
 assert.deepEqual([unknown.status,unknown.body.messageKey],[400,'apiError.release.pilotDevicesRequired'],'an unknown action');
 for(const payload of [{action:'set-token',token,managementToken:'proof-1'},{action:'set-token',token:'ghp_short'},{action:'remove-token',managementToken:'proof-2'}]){
  answer=await json(await api.POST(request(payload)));
  assert.deepEqual([answer.status,answer.body.messageKey],[unknown.status,unknown.body.messageKey],`${payload.action} answers like an unknown action`);
 }
 assert.deepEqual([await row(),await auditCount(),await proofRows(),proofs],[...before,[]],'no source row, audit row or proof changes, and no proof is read');
 const text=JSON.stringify((await json(await api.GET())).body);
 assert.ok(!text.includes(token)&&!/tokenSet/.test(text),'no answer has a token or a token field');
 // The importer stores the bare reason; the view gives its key. An unknown stored reason gives null.
 const time=Date.now();
 await context.database.exec(sql`INSERT INTO agent_release_imports(tag,version,source,status,reason,release_id,fingerprint,attempted_at,kind) VALUES('agent-v9.0.1','9.0.1','github','failed','rateLimited',NULL,'f1',${time},'agent'),('agent-v9.0.2','9.0.2','github','failed','somethingElse',NULL,'f2',${time+1},'agent'),('agent-v9.0.3','9.0.3','github','failed','serverMessage.releaseImport.signatureInvalid',NULL,'f3',${time+2},'agent')`);
 const reasons=Object.fromEntries((await json(await api.GET())).body.source.imports.map(item=>[item.tag,item.reason]));
 assert.deepEqual(reasons,{'agent-v9.0.1':'serverMessage.releaseImport.rateLimited','agent-v9.0.2':null,'agent-v9.0.3':'serverMessage.releaseImport.signatureInvalid'},'a bare reason maps to its key, an unknown one to null, a key stays');
 // A non-Owner with the update right sees the catalog without source and gets ownerOnly for check.
 context.setOwner(false);
 answer=await json(await api.GET());
 assert.deepEqual([answer.status,'source' in answer.body],[200,false]);
 assert.deepEqual(answer.body.history,history,'a non-Owner release viewer gets the history too');
 answer=await json(await api.POST(request({action:'check'})));
 assert.deepEqual([answer.status,answer.body.messageKey],[403,'apiError.releaseSource.ownerOnly'],'check');
 for(const payload of [{action:'set-token',token,managementToken:'proof-3'},{action:'remove-token',managementToken:'proof-3'}]){
  answer=await json(await api.POST(request(payload)));
  assert.deepEqual([answer.status,answer.body.messageKey],[400,'apiError.release.pilotDevicesRequired'],`${payload.action} for a non-Owner: an unknown action`);
 }
 assert.deepEqual(proofs,[],'no proof is ever read');
}));

test('release source: check by an Owner whose Owner role is removed in the database before the write answers ownerOnly, changes nothing and writes no audit row',async()=>fixture(async context=>{
 await context.database.exec(sql`CREATE TABLE release_source_owner(enabled INTEGER)`);await context.database.exec(sql`INSERT INTO release_source_owner VALUES(1)`);
 const live=async()=>Number((await context.database.one(sql`SELECT enabled FROM release_source_owner`)).enabled)===1;
 // The session still holds the Owner right (cached); only a fresh check and the SQL guard read the database.
 const policy={can:async(_viewer,_right,options)=>options?.fresh?live():true,requireCan:async()=>{},viewerCanSql:()=>sql`EXISTS(SELECT 1 FROM release_source_owner WHERE enabled=1)`};
 const api=await releaseApi(context,[],policy);
 const before=await context.database.one(sql`SELECT requested_at FROM agent_release_source WHERE id=1`);
 context.setBatch(()=>context.database.exec(sql`UPDATE release_source_owner SET enabled=0`));
 const response=await api.POST(request({action:'check'}));
 assert.deepEqual([response.status,(await response.json()).messageKey],[403,'apiError.releaseSource.ownerOnly']);
 assert.deepEqual(await context.database.one(sql`SELECT requested_at FROM agent_release_source WHERE id=1`),before,'requested_at does not change');
 assert.equal(Number((await context.database.one(sql`SELECT count(*) AS n FROM audit`)).n),0,'no audit row');
}));

// ---- Dev builds ----------------------------------------------------------------------
const devVersion='4.10.0-dev.abc1234';
test('a dev build is listed with dev but never latest: the bootstrap and the EXE download keep the latest release, also with dev builds on; a dev build is always deactivatable',async()=>fixture(async context=>{
 const dev=release(devVersion,Date.now());await context.save(dev);
 await context.database.exec(sql`UPDATE agent_release_source SET dev_builds=true WHERE id=1`);
 const catalog=await context.app.releases();
 assert.deepEqual(catalog.map(item=>[item.version,item.dev,item.latest]),[[devVersion,true,false],['4.9.0',false,true],['4.8.0',false,false]],'by rank: the dev build of 4.10.0 ranks highest, the latest is the highest release');
 assert.equal((await context.app.latestRelease()).version,'4.9.0');
 const {bootstrap,download}=await routes(context);
 assert.deepEqual((await read(await bootstrap.GET(new Request(origin+'/Agent-v3-release.json')))).body,{manifest:context.latest.manifest,signature:context.latest.signature},'the bootstrap serves the latest release');
 assert.equal((await download.GET()).headers.get('x-agent-version'),'4.9.0','the EXE download serves the latest release');
 // A dev build of the base of the latest ranks below it; a newer dev build than another of the same base sorts first.
 const sameBase=release('4.9.0-dev.bbbbbbb',Date.now()+5);await context.save(sameBase);
 assert.deepEqual((await context.app.releases()).map(item=>item.version),[devVersion,'4.9.0','4.9.0-dev.bbbbbbb','4.8.0']);
 // The highest-ranked dev build can be deactivated: only the latest release stays.
 const result=await context.app.retireRelease(dev.id,'disable','owner',context.guard);
 assert.equal(result.release.version,devVersion);
 assert.equal((await context.app.releases()).find(item=>item.id===dev.id).active,false);
 await context.app.retireRelease(sameBase.id,'delete','owner',context.guard);
 // With only dev builds: no latest, the bootstrap and the download answer noneAvailable.
 await context.database.exec(sql`INSERT INTO agent_release_states VALUES(${context.latest.id},'deleted',${Date.now()},'owner'),(${context.old.id},'deleted',${Date.now()},'owner')`);
 await context.database.exec(sql`DELETE FROM agent_release_states WHERE release_id=${dev.id}`);
 assert.deepEqual((await context.app.releases()).map(item=>[item.version,item.latest]),[[devVersion,false]]);
 assert.equal(await context.app.latestRelease(),null);
 context.tick(30000);
 const none=await read(await bootstrap.GET(new Request(origin+'/Agent-v3-release.json')));
 assert.deepEqual([none.status,none.body.messageKey],[404,'apiError.release.noneAvailable']);
 const noDownload=await read(await download.GET());
 assert.deepEqual([noDownload.status,noDownload.body.messageKey],[404,'apiError.release.noneAvailable']);
}));

test('deploy of a dev build: 409 devBuildsOff while off before any write; on, the rank rules: lower rank noDowngrade, the same string sameVersion, another dev build of the base is scheduled',async()=>fixture(async context=>{
 const dev=release(devVersion,Date.now());await context.save(dev);
 const api=await releaseApi(context),deploy=()=>api.POST(request({action:'deploy',releaseId:dev.id,serverIds:[context.serverId],confirm:true}));
 const jobs=async()=>Number((await context.database.one(sql`SELECT count(*) AS n FROM jobs`)).n);
 const on=(agentVersion)=>{context.devices=new Map([[context.serverId,{...context.device,snapshot:JSON.stringify({...context.snapshot,agentVersion})}]]);};
 on('4.9.0');
 let answer=await deploy();
 assert.deepEqual([answer.status,(await answer.json()).messageKey,await jobs()],[409,'apiError.release.devBuildsOff',0],'off: refused before any write');
 assert.equal(serverText('apiError.release.devBuildsOff'),'Dev builds are turned off. Turn on Import dev builds in Settings → Agent releases to deploy this build.');
 // The deploy of a release needs no switch.
 answer=await api.POST(request({action:'deploy',releaseId:context.old.id,serverIds:[context.serverId],confirm:true}));
 assert.equal((await answer.json()).messageKey,'apiError.release.noDowngrade','a release deploy keeps its own rules (4.8.0 below 4.9.0)');
 await context.database.exec(sql`UPDATE agent_release_source SET dev_builds=true WHERE id=1`);
 const cases=[['4.10.0','apiError.release.noDowngrade'],[devVersion,'apiError.release.sameVersion'],['4.11.0-dev.0000000','apiError.release.noDowngrade'],['broken','apiError.release.versionUnverifiable']];
 for(const [installed,key] of cases){on(installed);answer=await deploy();assert.deepEqual([answer.status,(await answer.json()).messageKey,await jobs()],[409,key,0],installed);}
 for(const installed of ['4.10.0-dev.bbbbbbb','4.9.0']){
  on(installed);answer=await deploy();
  assert.equal(answer.status,200,installed+': '+await answer.clone().text());
  assert.equal((await context.database.one(sql`SELECT target FROM jobs WHERE server_id=${context.serverId}`)).target,devVersion);
  await context.database.exec(sql`DELETE FROM jobs`);
 }
}));

test('the devBuilds action: Owner only before MFA, the same MFA as check, a boolean, one audit row per change and none for the same value; GET answers devBuilds to every release viewer',async()=>fixture(async context=>{
 const mfaCalls=[],mfa={requireMfa:async()=>{mfaCalls.push(1);if(mfaFail)throw new HttpError('apiError.mfa.loginRequired');},mfaSessionFence:async()=>sql`TRUE`,requireLiveSessions:async()=>{}};
 let mfaFail=false;
 const api=await releaseApi(context,[],undefined,mfa),post=payload=>api.POST(request(payload)),json=async response=>({status:response.status,body:await response.json()});
 const audits=async()=>(await context.database.query(sql`SELECT actor,action,target FROM audit WHERE action LIKE 'Agent dev builds%' ORDER BY at,action`)).map(row=>[row.action,row.target]);
 assert.equal((await json(await api.GET())).body.devBuilds,false,'off by default');
 // A non-Owner: ownerOnly before MFA.
 context.setOwner(false);mfaFail=true;
 let answer=await json(await post({action:'devBuilds',enabled:true}));
 assert.deepEqual([answer.status,answer.body.messageKey,mfaCalls.length],[403,'apiError.releaseSource.ownerOnly',0],'ownerOnly before MFA');
 // An Owner without MFA: the MFA error, nothing changes.
 context.setOwner(true);
 answer=await json(await post({action:'devBuilds',enabled:true}));
 assert.deepEqual([answer.status,answer.body.messageKey],[403,'apiError.mfa.loginRequired']);
 assert.deepEqual(await audits(),[]);
 mfaFail=false;
 for(const enabled of ['true',1,null,undefined]){answer=await json(await post({action:'devBuilds',enabled}));assert.deepEqual([answer.status,answer.body.messageKey],[400,'apiError.request.invalid'],String(enabled));}
 answer=await json(await post({action:'devBuilds',enabled:true}));
 assert.deepEqual([answer.status,Object.keys(answer.body),answer.body.source.devBuilds],[200,['source'],true],'the answer is { source }');
 assert.deepEqual(await audits(),[['Agent dev builds turned on','Agent releases']]);
 context.tick();answer=await json(await post({action:'devBuilds',enabled:true}));
 assert.deepEqual([answer.status,answer.body.source.devBuilds,(await audits()).length],[200,true,1],'the same value again writes nothing');
 context.tick();answer=await json(await post({action:'devBuilds',enabled:false}));
 assert.deepEqual([answer.body.source.devBuilds,await audits()],[false,[['Agent dev builds turned on','Agent releases'],['Agent dev builds turned off','Agent releases']]]);
 await post({action:'devBuilds',enabled:true});
 // Every release viewer gets devBuilds; only the Owner gets the source.
 context.setOwner(false);
 answer=await json(await api.GET());
 assert.deepEqual([answer.body.devBuilds,'source' in answer.body],[true,false]);
}));

test('the devBuilds action of an Owner whose Owner role goes away before the write answers ownerOnly and writes nothing',async()=>fixture(async context=>{
 await context.database.exec(sql`CREATE TABLE dev_builds_owner(enabled INTEGER)`);await context.database.exec(sql`INSERT INTO dev_builds_owner VALUES(1)`);
 const live=async()=>Number((await context.database.one(sql`SELECT enabled FROM dev_builds_owner`)).enabled)===1;
 const policy={can:async(_viewer,_right,options)=>options?.fresh?live():true,requireCan:async()=>{},viewerCanSql:()=>sql`EXISTS(SELECT 1 FROM dev_builds_owner WHERE enabled=1)`};
 const api=await releaseApi(context,[],policy);
 context.setBatch(()=>context.database.exec(sql`UPDATE dev_builds_owner SET enabled=0`));
 const response=await api.POST(request({action:'devBuilds',enabled:true}));
 assert.deepEqual([response.status,(await response.json()).messageKey],[403,'apiError.releaseSource.ownerOnly']);
 assert.equal((await context.database.one(sql`SELECT dev_builds FROM agent_release_source WHERE id=1`)).dev_builds,false);
 assert.equal(Number((await context.database.one(sql`SELECT count(*) AS n FROM audit`)).n),0);
}));
