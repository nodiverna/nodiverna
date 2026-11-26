// The migration of the MFA grant (drizzle/*_mfa_grants.sql, docs/portal-sessions.md): the switch "Ask for MFA after
// an automatic sign-out" stays on only when the newest switch audit row ends with "→ an"; a stored "1" without that
// choice, any other text and a newest "an → aus" become "0"; "0" stays "0" and a missing row stays missing. The
// migration drops mfa_browser_trust and adds mfa_grants and entra_sign_in_flows.grant_hash. A fresh database is migrated
// up to the migration before it, then the hand-written statement of the migration file runs for each stored state,
// and at the end the real migration runs through migrateDatabase.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase,SqlFragment,sql} from '../../runtime/database.mjs';
import {createTestDatabase} from '../support/postgres.mjs';
import {migrateDatabase} from '../../scripts/selfhost.mjs';

const drizzle=fileURLToPath(new URL('../../drizzle/',import.meta.url));
const names=fs.readdirSync(drizzle).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
const index=names.findIndex(name=>/^\d{4}_mfa_grants\.sql$/.test(name));
assert.ok(index>0,'the migration of the MFA grant exists');
const script=fs.readFileSync(path.join(drizzle,names[index]),'utf8').replaceAll('\r\n','\n');
const update=script.split('--> statement-breakpoint').find(part=>part.includes('UPDATE "identity_settings"'));
assert.ok(update,'the migration holds the hand-written update of the switch');
// Two directories: the migrations before the grant, and up to the grant (later migrations stay out).
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sd-switch-migration-'));
const directory=(name,files)=>{const target=path.join(folder,name);fs.mkdirSync(target);for(const file of files)fs.copyFileSync(path.join(drizzle,file),path.join(target,file));return target;};
const before=directory('before',names.slice(0,index)),upTo=directory('up-to',names.slice(0,index+1));

const target=await createTestDatabase({template:false});
const database=createDatabase({url:target.url,password:target.password,max:2,idleTimeoutSeconds:1});
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 await migrateDatabase(database,{directory:before});
 const action='MFA nach automatischer Abmeldung geändert';
 const stored=async()=>(await database.one(sql`SELECT value FROM identity_settings WHERE key='session_idle_requires_mfa'`))?.value??null;
 /** Sets the stored switch (null: no row) and the switch audit targets in their order (the last is the newest). */
 async function state(value,targets){
  await database.exec(sql`DELETE FROM identity_settings WHERE key='session_idle_requires_mfa'`);
  await database.exec(sql`DELETE FROM audit WHERE action=${action}`);
  if(value!==null)await database.exec(sql`INSERT INTO identity_settings(key,value) VALUES('session_idle_requires_mfa',${value})`);
  let at=1_700_000_000_000;
  for(const auditTarget of targets)await database.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope,customer_id) VALUES(${at++},'owner@local.test',${action},${auditTarget},NULL,'portal',NULL)`);
  // Another action with "→ an" never counts.
  await database.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope,customer_id) VALUES(${at+1000},'owner@local.test','Automatische Abmeldung geändert','aus → an',NULL,'portal',NULL)`);
 }
 // The statement of the file without its comment lines, as one SQL text without parameters.
 const statement=update.split('\n').filter(line=>!line.startsWith('--')).join('\n').trim().replace(/;$/,'');
 const migrateSwitch=()=>database.exec(new SqlFragment([statement],[]));
 for(const [label,value,targets,expected] of [
  ['stored 1 without a switch audit row',"1",[],'0'],
  ['stored 1, newest target aus → an',"1",['an → aus','aus → an'],'1'],
  ['stored 1, newest target an → aus',"1",['aus → an','an → aus'],'0'],
  ['stored 0, newest target aus → an',"0",['aus → an'],'0'],
  ['stored 0 without audit',"0",[],'0'],
  ['an unknown text without audit','x',[],'0'],
  ['an unknown text, newest target aus → an','x',['aus → an'],'1'],
  ['a missing row',null,['aus → an'],null],
 ]){
  await state(value,targets);await migrateSwitch();
  check(await stored(),expected,label);
 }
 // The real migration through migrateDatabase.
 await state('1',['an → aus','aus → an']);
 check(!!await database.one(sql`SELECT 1 AS present FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename='mfa_browser_trust'`),true,'before: mfa_browser_trust exists');
 await database.exec(sql`INSERT INTO mfa_browser_trust(token_hash,principal,created_at,expires_at,passkey_id) VALUES('trust','local:someone',1,2,NULL)`);
 await migrateDatabase(database,{directory:upTo});
 check(await stored(),'1','the real migration keeps an explicit Owner choice on');
 const tables=async name=>!!await database.one(sql`SELECT 1 AS present FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename=${name}`);
 check([await tables('mfa_browser_trust'),await tables('mfa_grants')],[false,true],'mfa_browser_trust is gone (nothing copied); mfa_grants exists');
 check(!!await database.one(sql`SELECT 1 AS present FROM information_schema.columns WHERE table_name='entra_sign_in_flows' AND column_name='grant_hash' AND is_nullable='YES'`),true,'entra_sign_in_flows.grant_hash is a nullable column');
 check(Number((await database.one(sql`SELECT count(*) AS n FROM mfa_grants`)).n),0,'no grant is created by the migration');
 console.log(`PASS session switch migration (${checks} checks): the switch stays on only after an explicit Owner choice, 0 and a missing row stay, mfa_browser_trust is dropped, mfa_grants and grant_hash exist.`);
}finally{
 await database.close();await target.drop();
 fs.rmSync(folder,{recursive:true,force:true});
}
