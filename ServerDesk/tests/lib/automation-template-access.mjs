// Reference templates contain copied file/configuration values. These tests
// exercise the real catalog and assignment SQL, including the commit boundary.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';

import {sourceDatabase,inTransaction} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
const require=createRequire(import.meta.url),d=await sourceDatabase(),cache=new Map(),root=process.cwd(),uuid=()=>crypto.randomUUID();
const clock=Date.now();let beforeWrite=null,checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const HttpError=realHttpError;
// beforeWrite runs once, right before the next INSERT, UPDATE or DELETE statement.
const facade=hookDatabase(d,{statement:async text=>{if(beforeWrite&&/^\s*(?:INSERT|UPDATE|DELETE)/i.test(text)){const hook=beforeWrite;beforeWrite=null;await hook();}}});
const server={db:()=>facade,now:()=>clock,hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),guid:value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value),HttpError,log:async()=>{}};
const mocks=new Map([
 ['lib/server/context.ts',server],['lib/server/identity/local-auth.ts',{}],
 ['lib/server/identity/mfa.ts',{isMfaEnabled:async()=>true}],
 ['lib/management.ts',{operations:{}}],['lib/server/agent/agent-crypto.ts',{sealAgentSecrets:async()=>({})}]
]);
function load(filename){
 const absolute=path.resolve(filename),relative=path.relative(root,absolute).replaceAll('\\','/');if(mocks.has(relative))return mocks.get(relative);if(cache.has(absolute))return cache.get(absolute).exports;
 const loaded={exports:{}};cache.set(absolute,loaded);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const localRequire=id=>{if(id.startsWith('.')){const base=path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());if(file)return /[.]m?js$/.test(file)?require(file):load(file);}return require(id);};
 new Function('require','module','exports',code)(localRequire,loaded,loaded.exports);return loaded.exports;
}
const scopes=load('lib/server/automation/automation-scopes.ts'),access=load('lib/server/identity/access.ts'),drift=load('lib/server/automation/drift.ts');
try{
 const creator={id:uuid(),label:'creator@templates.test'},outsider={id:uuid(),label:'outsider@templates.test'},owner={id:uuid(),label:'owner@templates.test',permissions:['*']};
 for(const viewer of[creator,outsider,owner])Object.defineProperty(viewer,'authorization',{value:{authVersion:1},enumerable:false});
 const creatorActor=access.principal(creator),ownerActor=access.principal(owner),source=uuid(),target=uuid(),sourceGroup=uuid(),targetGroup=uuid(),ownerRole=uuid(),manageRole=uuid(),template=uuid();
 const rights=['view','drift.read','drift.manage','drift.contents'];
 const policy=drift.driftPolicySchema.parse({enabled:true,paths:[{path:'C:\\Reference',includeText:true,extensions:['.txt']}]});
 const payload=JSON.stringify({policy,baseline:[{key:'file:c:\\reference\\app.txt',kind:'file',path:'C:\\Reference\\app.txt',hash:'a'.repeat(64),text:'reference-secret'}],sourceServerId:source,sourceReportId:uuid()});
 await inTransaction(d,[
  ...[creator,outsider,owner].map(viewer=>sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,must_reset,created_at,updated_at) VALUES(${viewer.id},${viewer.label},${viewer.label},${viewer.label},${access.principal(viewer)},${viewer.label},'active',1,0,${clock},${clock})`),
  ...[creator,outsider,owner].map(viewer=>sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${access.principal(viewer)},'fixture','[]',0,${clock-1000})`),
  sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${ownerRole},'Owner','','["*"]',0,${clock})`,
  sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${manageRole},'Drift manager','',${JSON.stringify(rights)},0,${clock})`,
  ...[[sourceGroup,'Reference'],[targetGroup,'Target']].map(([id,name])=>sql`INSERT INTO device_groups(id,name,description,created_at) VALUES(${id},${name},'',${clock})`),
  ...[[source,'Reference'],[target,'Own device']].map(([id,name])=>sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen) VALUES(${id},${name},${id},${clock},${clock})`),
  ...[[source,sourceGroup],[target,targetGroup]].map(([device,group])=>sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${device},${group})`),
  ...[creator,outsider,owner].map(viewer=>sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${viewer.id},${manageRole},'devicegroup',${targetGroup},${clock},${creatorActor})`),
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${creator.id},${manageRole},'devicegroup',${sourceGroup},${clock},${creatorActor})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${owner.id},${ownerRole},'global','*',${clock},${creatorActor})`,
  sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES(${template},'drift','default','Reference baseline',${payload},${creatorActor},${clock})`
 ]);
 const assign=viewer=>scopes.assignAutomationScope(viewer,{templateId:template,scopeType:'group',scopeId:targetGroup,confirm:true});
 const assignments=async()=>Number((await d.one(sql`SELECT count(*) AS n FROM automation_scope_assignments`)).n);
 const clear=()=>d.exec(sql`DELETE FROM automation_scope_assignments`);
 const rejected=async(viewer,status,label)=>{await assert.rejects(()=>assign(viewer),error=>error instanceof HttpError&&error.status===status,label);checks++;};
 check((await scopes.listAutomationScopes(creator)).templates.some(row=>row.id===template),true,'creator sees owned reference template');
 check((await scopes.listAutomationScopes(owner)).templates.some(row=>row.id===template),true,'current owner sees reference template');
 check((await scopes.listAutomationScopes(outsider)).templates.some(row=>row.id===template),false,'unrelated target manager does not see reference template');
 await rejected(outsider,403,'drift.read and drift.manage on an unrelated device cannot use a hidden reference template');check(await assignments(),0,'denied direct API request does not materialize a scope');
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${outsider.id},${manageRole},'devicegroup',${sourceGroup},${clock},${creatorActor})`);
 await rejected(outsider,403,'even source management is not an implicit template-sharing grant');
 check((await scopes.listAutomationScopes(outsider)).templates.some(row=>row.id===template),false,'catalog and direct assignment use the same explicit creator/owner boundary');
 await assign(creator);check(await assignments(),1,'creator with target permissions can assign own reference template');await clear();
 await assign(owner);check(await assignments(),1,'current owner can assign another creator reference template');await clear();

 for(const[label,change,restore] of[
  ['owner privilege lost',()=>d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id=${ownerRole}`),()=>d.exec(sql`UPDATE rbac_roles SET permissions='["*"]' WHERE id=${ownerRole}`)],
  ['template payload changed',()=>d.exec(sql`UPDATE automation_templates SET payload=${JSON.stringify({...JSON.parse(payload),sourceServerId:target})} WHERE id=${template}`),()=>d.exec(sql`UPDATE automation_templates SET payload=${payload} WHERE id=${template}`)],
  ['template archived',()=>d.exec(sql`UPDATE automation_templates SET archived=1 WHERE id=${template}`),()=>d.exec(sql`UPDATE automation_templates SET archived=0 WHERE id=${template}`)],
  ['account disabled',()=>d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${owner.id}`),()=>d.exec(sql`UPDATE local_users SET status='active' WHERE id=${owner.id}`)],
  ['password approval changed',()=>d.exec(sql`UPDATE local_users SET auth_version=2 WHERE id=${owner.id}`),()=>d.exec(sql`UPDATE local_users SET auth_version=1 WHERE id=${owner.id}`)]
 ]){
  beforeWrite=change;await rejected(owner,409,label+': rechecked in committing INSERT');check(await assignments(),0,label+': no stale reference-data distribution');await restore();
 }
 await d.exec(sql`UPDATE rbac_roles SET permissions='[]' WHERE id=${ownerRole}`);
 check((await scopes.listAutomationScopes(owner)).templates.some(row=>row.id===template),false,'stale Viewer admin role does not expose creator-owned drift catalog');
 await rejected(owner,403,'stale Viewer admin role does not bypass direct template access');
 await d.exec(sql`UPDATE rbac_roles SET permissions='["*"]' WHERE id=${ownerRole}`);
 beforeWrite=()=>d.exec(sql`UPDATE automation_templates SET created_by=${ownerActor} WHERE id=${template}`);
 await rejected(creator,409,'creator ownership revoked during commit');check(await assignments(),0,'ownership change never becomes implicit sharing');
 console.log(`PASS ${checks} template access checks: creator/current Owner only, catalog/direct API consistency, unrelated/source management not sharing, and owner/payload/archive/account/password/ownership commit races.`);
}finally{d.close();}
