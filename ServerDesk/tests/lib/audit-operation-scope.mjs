import {HttpError as realHttpError} from '../support/http-error.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import {sql} from '../../runtime/database.mjs';

import {customerSeparationSql} from '../../runtime/customer-separation.mjs';
import {dbModule,sourceDatabase} from '../support/source-database.mjs';
import {serverDeskRoot} from '../support/paths.mjs';
// Exercise real operation functions and transaction results. Authorization helpers
// are allowed locally; no identity, production database or device is contacted.
const root=serverDeskRoot;
const require=createRequire(import.meta.url),ts=require('typescript'),{z}=require('zod');
const database=await sourceDatabase(),events=[];
const ids=Object.fromEntries(['scheduled-a', 'scheduled-b', 'active-device', 'historical-device', 'book', 'version', 'schedule', 'active-run', 'historic-run', 'config', 'portal-config', 'config-version', 'portal-config-version', 'assignment', 'old-assignment', 'desired-run', 'pending-job'].map(name=>[name,crypto.randomUUID()]));
const HttpError=realHttpError;
const allow=()=>(sql`TRUE`),viewer={id:'owner',label:'Owner',permissions:['*']};
const deps={z,customerSeparationSql,...dbModule(),db:()=>database,now:()=>Date.now(),guid:id=>z.guid().safeParse(id).success,HttpError,log:async(...args)=>events.push(structuredClone(args)),principal:()=> 'owner',requireDevice:async(v,id)=>database.one(sql`SELECT * FROM servers WHERE id=${id}`),allowedDeviceIds:async()=>[],hasGlobalPermission:async()=>true,resolvePrincipal:async()=>viewer,isMfaEnabled:async()=>true,devicePermissionGuard:allow,anyDevicePermissionGuard:allow,globalOwnerGuard:allow,globalPermissionGuard:allow,featureWriteGuard:(v,guard)=>guard,featureTargetsGuard:allow,can:async()=>true,requireCan:async()=>{},canSql:allow,viewerCanSql:allow,operations:{refresh:{schema:z.object({})}},sealAgentSecrets:async()=>({}),config:()=>'',hash:async()=>'',desiredEngine:z.enum(['dsc3']),desiredParameters:z.record(z.string(),z.unknown()),validateDesiredContent:()=>{}};
// The plain catalog, server message and field path helpers by their imported names.
Object.assign(deps,{translate:(await import('../../lib/i18n/translate.ts')).translate,defaultLocale:(await import('../../lib/i18n/locale.ts')).defaultLocale,...await import('../../lib/server-messages.ts'),...await import('../../lib/server/errors/issues.ts')});
function load(file){const source=fs.readFileSync(path.join(root,file),'utf8').replace(/^import[^\n]*\n/gm,'');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;return new Function('exports',...Object.keys(deps),code+';return exports;')({},...Object.values(deps));}
try{
 // The real catalog rules; with only the default customer everything is library.
 Object.assign(deps,{customerAccessGuard:()=>(sql`TRUE`),visibleCustomers:async()=>[],customerUnavailableMessage:''});Object.assign(deps,load('lib/server/catalog-ownership.ts'));
 Object.assign(deps,load('lib/jobs/runbook-step.ts'));
 const runbooks=load('lib/server/automation/runbooks.ts'),desired=load('lib/server/automation/desired-state.ts');
 const at=Date.now();
 for(const id of [ids['scheduled-a'],ids['scheduled-b'],ids['active-device'],ids['historical-device']])await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES(${id},${id},${'token-'+id},${at})`);
 await database.exec(sql`INSERT INTO runbooks(id,name,description,created_at,created_by) VALUES(${ids['book']},${'Audit fixture'},${''},${at},${'owner'})`);
 await database.exec(sql`INSERT INTO runbook_versions(id,runbook_id,version,definition,created_at,created_by) VALUES(${ids['version']},${ids['book']},${1},${'{}'},${at},${'owner'})`);
 await database.exec(sql`INSERT INTO runbook_schedules(id,version_id,actor,targets,parameters,recurrence,next_due,catchup_seconds,concurrency,failure_stop,approved_at,created_at) VALUES(${ids['schedule']},${ids['version']},${'owner'},${JSON.stringify([ids['scheduled-a'],ids['scheduled-b']])},${'{}'},${'{"kind":"interval","minutes":5}'},${at},${300},${1},${1},${at},${at})`);
 for(const [id,state,device] of [[ids['active-run'],'queued',ids['active-device']],[ids['historic-run'],'succeeded',ids['historical-device']]]){await database.exec(sql`INSERT INTO runbook_runs(id,version_id,actor,state,parameters,concurrency,failure_stop,created_at,expires_at) VALUES(${id},${ids['version']},${'owner'},${state},${'{}'},${1},${1},${at},${at+300000})`);await database.exec(sql`INSERT INTO runbook_run_devices(run_id,server_id,state) VALUES(${id},${device},${state})`);}
 await runbooks.deleteRunbook(viewer,{confirm:true,runbookId:ids['book']});
 assert.deepEqual(new Set(events.at(-1)[3]),new Set([ids['scheduled-a'],ids['scheduled-b'],ids['active-device']]));
 assert.equal(events.at(-1)[2],ids['book']);
 assert.equal((await database.one(sql`SELECT archived FROM runbooks WHERE id=${ids['book']}`)).archived,1);
 assert.equal((await database.one(sql`SELECT enabled FROM runbook_schedules WHERE id=${ids['schedule']}`)).enabled,0);
 assert.equal((await database.one(sql`SELECT state FROM runbook_runs WHERE id=${ids['active-run']}`)).state,'cancelled');
 assert.equal((await database.one(sql`SELECT state FROM runbook_runs WHERE id=${ids['historic-run']}`)).state,'succeeded');
 for(const [id,name] of [[ids['config'],'Configuration'],[ids['portal-config'],'Portal only']]){await database.exec(sql`INSERT INTO desired_configs(id,name,created_by,created_at) VALUES(${id},${name},${'owner'},${at})`);await database.exec(sql`INSERT INTO desired_versions(id,config_id,version,engine,content,sha256,created_by,created_at) VALUES(${id===ids.config?ids['config-version']:ids['portal-config-version']},${id},${1},${'dsc3'},${'{}'},${'checksum'},${'owner'},${at})`);}
 await database.exec(sql`INSERT INTO desired_assignments(id,server_id,version_id,assigned_by,assigned_at) VALUES(${ids['assignment']},${ids['scheduled-a']},${ids['config-version']},${'owner'},${at})`);
 await database.exec(sql`INSERT INTO desired_runs(id,assignment_id,server_id,version_id,job_id,operation,created_at,created_by) VALUES(${ids['desired-run']},${ids['old-assignment']},${ids['scheduled-b']},${ids['config-version']},${ids['pending-job']},${'test'},${at},${'owner'})`);
 await database.exec(sql`INSERT INTO jobs(id,server_id,action,target,parameters,created_at,actor) VALUES(${ids['pending-job']},${ids['scheduled-b']},${'desired-state-test'},${'configuration'},${'{}'},${at},${'owner'})`);
 const deletion=await desired.deleteDesiredConfiguration(viewer,{confirmDelete:true,configId:ids['config']});
 assert.equal(deletion.removedAssignments,1);assert.equal(deletion.cancelledJobs,1);
 assert.deepEqual(new Set(events.at(-1)[3]),new Set([ids['scheduled-a'],ids['scheduled-b']]));
 assert.equal(events.at(-1)[2],'Configuration / '+ids.config);
 assert.equal((await database.one(sql`SELECT state FROM jobs WHERE id=${ids['pending-job']}`)).state,'cancelled');
 await desired.deleteDesiredConfiguration(viewer,{confirmDelete:true,configId:ids['portal-config']});
 assert.equal(events.at(-1)[3],undefined,'configuration without device impact remains portal scoped');
 console.log('PASS audit caller deletion scopes: scheduled and active devices, no historical leakage, actual returned changes, portal-only fallback');
}finally{database.close();}
