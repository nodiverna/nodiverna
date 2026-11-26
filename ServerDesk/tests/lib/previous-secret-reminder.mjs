// The reminder to remove SESSION_SECRET_PREVIOUS once no stored secret needs
// it: the startup warning (runtime/previous-secret.mjs, runtime/startup.mjs)
// with stub databases, and the Owner-only flag of GET /api/console with the
// real route, lib/server/console-data.ts and policy checks on a PostgreSQL test database.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {compile,sql} from '../../runtime/database.mjs';
import {checkPreviousSecretAtStartup,previousSecretWarning} from '../../runtime/previous-secret.mjs';
import {createKeyring,encryptWithKeyring,keyId} from '../../runtime/secret-keyring.mjs';
import {insertRow,sourceDatabase,sourceLoader} from '../support/source-database.mjs';

let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const A='reminder-secret-A-'+'a'.repeat(40),B='reminder-secret-B-'+'b'.repeat(40);
const rotated={SESSION_SECRET:B,SESSION_SECRET_PREVIOUS:A};
const noSecretIn=async text=>{for(const value of [A,B,await keyId(A),await keyId(B)])check(text.includes(value),false,'no secret and no kid');check(/\d/.test(text),false,'no count');};

// 1. The startup check with stub databases.
function stub({pending=0,fail=false}={}){
 const state={opened:0,closed:0,queries:[]};
 const open=()=>{state.opened++;return {one:async statement=>{state.queries.push(compile(statement).text);if(fail)throw new Error('relation "mfa_accounts" does not exist');return {pending};},close:async()=>{state.closed++;}};};
 return {state,open};
}
async function startup(env,database,opener=database.open){
 const lines=[];
 const result=await checkPreviousSecretAtStartup({env,openDatabase:opener,warn:line=>lines.push(line)});
 return {result,lines};
}
check(previousSecretWarning,'ServerDesk: SESSION_SECRET_PREVIOUS is still set, but every stored secret uses the current SESSION_SECRET. Remove SESSION_SECRET_PREVIOUS and restart the portal.','the startup text');
await noSecretIn(previousSecretWarning.replace('ServerDesk: ',''));
{
 const removable=stub(),run=await startup(rotated,removable);
 check(run,{result:true,lines:[previousSecretWarning]},'removable: exactly one warning');
 check([removable.state.opened,removable.state.closed,removable.state.queries.length],[1,1,1],'one connection, one query, closed again');
}
{
 const pending=stub({pending:3}),run=await startup(rotated,pending);
 check(run,{result:false,lines:[]},'values still need the previous secret: no warning');
 check([pending.state.opened,pending.state.closed],[1,1],'closed again');
}
{
 const failing=stub({fail:true}),run=await startup(rotated,failing);
 check(run,{result:false,lines:[]},'a missing table writes nothing and does not reject');
 check(failing.state.closed,1,'closed after the error');
 check(await startup(rotated,null,()=>{throw new Error('connect ECONNREFUSED');}),{result:false,lines:[]},'an unreachable database writes nothing');
 check(await startup(rotated,null,async()=>{throw new Error('connect ETIMEDOUT');}),{result:false,lines:[]},'a failed asynchronous open writes nothing');
 const closing={open:()=>({one:async()=>({pending:0}),close:async()=>{throw new Error('close failed');}})};
 check(await startup(rotated,closing),{result:true,lines:[previousSecretWarning]},'a failing close does not hide the warning');
}
for(const [env,label] of [[{SESSION_SECRET:B},'no previous secret'],[{SESSION_SECRET:B,SESSION_SECRET_PREVIOUS:''},'an empty previous secret'],[{SESSION_SECRET:B,SESSION_SECRET_PREVIOUS:` ${B} `},'the previous secret equals the current one'],[{SESSION_SECRET:'short',SESSION_SECRET_PREVIOUS:A},'an invalid current secret']]){
 let opened=0;
 check(await startup(env,null,()=>{opened++;throw new Error('opened');}),{result:false,lines:[]},label);
 check(opened,0,`${label}: no connection`);
}
// runtime/startup.mjs runs the check after validateEnvironment, without awaiting it.
const startupSource=fs.readFileSync('runtime/startup.mjs','utf8');
check(startupSource.indexOf('validateEnvironment();')<startupSource.indexOf("import('./previous-secret.mjs')"),true,'after validateEnvironment()');
check(/\bawait\b/.test(startupSource),false,'not awaited: the start does not wait');
check(/\.catch\(\(\) => \{\}\)/.test(startupSource),true,'a failed import or check never rejects');

// 2. GET /api/console: the flag only for Owners and only when removable.
const database=await sourceDatabase(),statements=[];
const recorded=target=>({query:s=>{statements.push(compile(s).text);return target.query(s);},one:s=>{statements.push(compile(s).text);return target.one(s);},exec:s=>{statements.push(compile(s).text);return target.exec(s);}});
const facade={...recorded(database),transaction:(callback,options)=>database.transaction(tx=>callback(recorded(tx)),options),close:async()=>{}};
globalThis[Symbol.for('serverdesk.runtime.database')]=facade;
try{
 let settings={},viewer=null;
 const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
 const HttpError=realHttpError;
 const server={db:()=>facade,now:()=>Date.now(),config:key=>settings[key]??'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
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
 const consoleApi=sourceLoader()('app/api/console/route.ts',imports);
 const time=Date.now();
 async function persona(name,permissions){
  const id=crypto.randomUUID(),roleId=crypto.randomUUID();
  await insertRow(database,'local_users',{id,username:name,email:name+'@reminder.test',display_name:name,auth_principal:'local:'+id,auth_email:name+'@reminder.test',status:'active',auth_version:1,created_at:time,updated_at:time});
  await insertRow(database,'rbac_roles',{id:roleId,name:'Reminder '+name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});
  await insertRow(database,'role_assignments',{id:crypto.randomUUID(),principal_type:'user',principal_id:id,role_id:roleId,scope_type:'global',scope_id:'*',created_at:time,created_by:'fixture'});
  return {id,userId:id,label:name+'@reminder.test',principal:'local:'+id};
 }
 const owner=await persona('owner',['*']),operator=await persona('operator',['view']);
 const get=async(actor,env)=>{viewer=actor;settings=env;statements.length=0;const response=await consoleApi.GET(new Request('https://reminder.test/api/console'));check(response.status,200,'console data');return response.json();};
 const statusQueries=()=>statements.filter(text=>text.includes('starts_with(secret_enc')).length;

 // No previous secret: no flag and no status query.
 let data=await get(owner,{SESSION_SECRET:B});
 check(['maintenance' in data,'previousSecretRemovable' in data,statusQueries()],[true,false,0],'Owner without SESSION_SECRET_PREVIOUS: no flag, no query');
 // Previous set and no stored value needs it: only the Owner sees the flag.
 data=await get(owner,rotated);
 check([data.previousSecretRemovable,statusQueries()],[true,1],'Owner, removable: the flag, one query');
 await noSecretIn(JSON.stringify({previousSecretRemovable:data.previousSecretRemovable}));
 data=await get(operator,rotated);
 check(['maintenance' in data,'previousSecretRemovable' in data,statusQueries()],[false,false,0],'non-Owner: no key and no query');
 // A value under the previous secret: not removable, no flag.
 const value=await encryptWithKeyring(createKeyring({SESSION_SECRET:A}),'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP','local:'+owner.id);
 await insertRow(database,'mfa_authenticators',{id:'reminder-auth',principal:'local:'+owner.id,name:'Phone',secret_enc:value,last_counter:-1,created_at:time,last_used_at:null});
 data=await get(owner,rotated);
 check(['previousSecretRemovable' in data,statusQueries()],[false,1],'a value still under A: no flag');
 // A value under the current secret only: removable again.
 await database.exec(sql`UPDATE mfa_authenticators SET secret_enc=${await encryptWithKeyring(createKeyring({SESSION_SECRET:B}),'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP','local:'+owner.id)} WHERE id='reminder-auth'`);
 check((await get(owner,rotated)).previousSecretRemovable,true,'every value under B: the flag');
 // A broken previous entry never breaks the console.
 data=await get(owner,{SESSION_SECRET:B,SESSION_SECRET_PREVIOUS:'short'});
 check('previousSecretRemovable' in data,false,'an invalid previous secret: no flag, no error');
 const route=fs.readFileSync('app/api/console/route.ts','utf8');
 check(/\.\.\.\(owner\?\{maintenance:[^}]*consolePreviousSecretRemovable\(/.test(route),true,'the flag sits in the Owner-only part');
 console.log(`PASS ${checks} previous-secret reminder checks: startup warning once, no warning when pending or failing, no connection without a previous secret, Owner-only console flag only when removable.`);
}finally{await database.close();}
