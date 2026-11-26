// The account check through Microsoft Graph (lib/server/identity/entra/directory-check.ts,
// lib/server/identity/entra/graph.ts, docs/entra-id.md "Account check"): the 15-minute lease,
// the client-credentials token and its reuse, the retry after a Graph 401, the
// host check, the lock of disabled and deleted accounts with the last-Owner
// rule, the removal of lost mapped groups, the race guards of each commit, the
// run-level failures with their audit rows, the order, cap and time budget of a
// run, at most 4 requests in flight, and no secret, token or Graph text in any
// stored value or log line. Real lib/server/identity/entra/*, lib/server/identity/local-auth.ts and
// lib/server/identity/access.ts on an isolated PostgreSQL database with a fake Microsoft Graph
// on the transport seam (tests/support/entra-fixture.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {entraFixture,tenant,selfSignedCertificate} from '../support/entra-fixture.mjs';
import {sql} from '../../runtime/database.mjs';

// Every console line of the run, to prove that no token or Graph text reaches a log.
const logged=[];
for(const level of ['log','info','warn','error']){const original=console[level];console[level]=(...parts)=>{logged.push(parts.map(String).join(' '));original(...parts);};}

const f=await entraFixture(),{d,m,microsoft}=f;
const graph=f.load('lib/server/identity/entra/graph.ts'),dc=f.load('lib/server/identity/entra/directory-check.ts');
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const minute=60_000,tenant2='33333333-4444-4555-8666-777777777777';
const oid=n=>`c0c0c0c0-0000-4000-8000-${String(n).padStart(12,'0')}`;
const group=n=>`0b0b0b0b-0000-4000-8000-${String(n).padStart(12,'0')}`;
const groupOps=group(1),groupAdmins=group(2),groupUnmapped=group(999);
const directory=new Map();
const clockNow=()=>Date.now()+f.offset;
try{
 await f.configure();
 const owner=await f.localAccount('owner@check.test');
 const hasActorPrincipal=!!await d.one(sql`SELECT 1 AS present FROM information_schema.columns WHERE table_name='jobs' AND column_name='actor_principal'`);

 // ---- Helpers ------------------------------------------------------------------------
 /** Back to the default fake Microsoft, with the directory of this test. */
 const reset=()=>{f.resetMicrosoft();microsoft.directory=directory;};
 const run=(options={})=>dc.runEntraDirectoryCheck(options.time??clockNow(),options.clock?{clock:options.clock}:{});
 const due=()=>d.exec(sql`UPDATE entra_directory_check SET last_started_at=NULL,lease_until=NULL WHERE id=1`);
 const checkRow=async()=>({...await d.one(sql`SELECT * FROM entra_directory_check WHERE id=1`)});
 /** Signs `oid` in with `groups` and puts it into the directory (enabled, member of `member`, default all of `groups`). */
 const signInAs=async(objectId,groups=[],{member=groups,enabled=true}={})=>{
  reset();microsoft.claims={oid:objectId,groups};
  const result=await f.signIn();reset();
  assert.equal(result.target,'/',`sign-in of ${objectId}`);
  directory.set(objectId,{enabled,groups:member});
  const user={...await d.one(sql`SELECT * FROM local_users WHERE entra_object_id=${objectId}`)};
  return {...result,user};
 };
 /** Every active Entra account goes out of the way of the next section. */
 const retire=async()=>{await d.exec(sql`UPDATE local_users SET status='disabled' WHERE identity_source='entra'`);directory.clear();};
 const mapping=(groupObjectId,roleId)=>d.exec(sql`INSERT INTO entra_group_roles(id,group_object_id,group_name,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},${groupObjectId},'Group',${roleId},'global','*',0,'fixture')`);
 const userRow=async id=>({...await d.one(sql`SELECT status,auth_version,entra_checked_at,last_login_at FROM local_users WHERE id=${id}`)});
 const sessions=id=>f.count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${id}`);
 const mfaSessions=principal=>f.count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${principal}`);
 const groupsOf=async id=>(await d.query(sql`SELECT group_object_id FROM entra_user_groups WHERE user_id=${id} ORDER BY group_object_id`)).map(row=>row.group_object_id);
 const rolesOf=async id=>(await d.query(sql`SELECT role_id,source FROM role_assignments WHERE principal_type='user' AND principal_id=${id} ORDER BY role_id`)).map(row=>[row.role_id,row.source]);
 const auditOf=async action=>(await f.auditRows(action)).map(row=>[row.actor,row.target]);
 const graphCalls=()=>microsoft.calls.filter(call=>new URL(call.url).host==='graph.microsoft.com').map(call=>({method:call.method,path:new URL(call.url).pathname.replace(/^\/v1\.0/,''),search:new URL(call.url).search,auth:call.headers?.Authorization,body:call.body?JSON.parse(call.body):null}));
 const userCalls=()=>graphCalls().filter(call=>call.method==='GET'&&/^\/users\/[^/]+$/.test(call.path)).map(call=>call.path.slice('/users/'.length));
 const tokenCalls=()=>microsoft.calls.filter(call=>call.url.endsWith('/oauth2/v2.0/token')).map(call=>Object.fromEntries(new URLSearchParams(call.body)));
 reset();

 // ---- Lease ---------------------------------------------------------------------------
 {
  await f.configure({enabled:0});
  const before=await checkRow();
  check(await run(),{status:'skipped'},'skipped while sign-in is off');
  // Incomplete settings are only possible while off (CHECK entra_settings_complete).
  await d.exec(sql`UPDATE entra_settings SET secret_enc=NULL`);
  check(await run(),{status:'skipped'},'skipped while the settings are incomplete');
  check(await checkRow(),before,'a skipped run changes nothing');
  await f.configure();
  const time=clockNow(),first=await run({time});
  check(first,{status:'ran',result:'ok',checked:0,locked:0,groupChanges:0,remaining:0},'the first run');
  const row=await checkRow();
  check([Number(row.last_started_at),row.lease_until,Number(row.last_finished_at)>=time,row.last_result,Number(row.settings_revision)],[time,null,true,'ok',1],'the run took and freed the lease');
  check(await run({time:time+14*minute}),{status:'skipped'},'skipped within 15 minutes of the last start');
  check((await run({time:time+15*minute})).status,'ran','due 15 minutes after the last start');
  await d.exec(sql`UPDATE entra_directory_check SET last_started_at=NULL,lease_until=${clockNow()+minute} WHERE id=1`);
  check(await run(),{status:'skipped'},'skipped while another lease holds');
  await due();
  const both=await Promise.all([run(),run()]);
  check(both.map(result=>result.status).sort(),['ran','skipped'],'two concurrent calls: one run');
  check(await auditOf('auth.entra.check.%'),[],'ok runs from the start write no run row');
 }

 // ---- Token: client credentials, reuse, 401 retry, host check ---------------------------
 {
  const a=await signInAs(oid(1)),b=await signInAs(oid(2));
  reset();await due();
  check((await run()).checked,2,'two accounts checked');
  const tokens=tokenCalls();
  check(tokens.map(form=>[form.grant_type,form.scope,form.client_id,form.client_secret]),[['client_credentials','https://graph.microsoft.com/.default','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',`client-secret-value`]],'one client-credentials token with the secret for every account');
  check(graphCalls().map(call=>[call.method,call.search,call.auth]).sort(),[['GET','?$select=id,accountEnabled','Bearer graph-token'],['GET','?$select=id,accountEnabled','Bearer graph-token']],'GET /users/<oid>?$select=id,accountEnabled with the token');
  check(userCalls().sort(),[oid(1),oid(2)],'each account by its object ID');
  check([(await userRow(a.user.id)).entra_checked_at!==null,(await userRow(b.user.id)).entra_checked_at!==null],[true,true],'entra_checked_at is set for each checked account');
  microsoft.calls=[];await due();await run();
  check(tokenCalls().length,0,'the next run reuses the token while more than 5 minutes remain');
  microsoft.calls=[];await due();await run({time:clockNow()+56*minute,clock:()=>clockNow()+56*minute});
  check(tokenCalls().length,1,'a new token when 5 minutes or less remain');
  // A Graph 401 drops the token, fetches one new token and repeats once.
  reset();let issued=0;
  microsoft.token=()=>({status:200,body:JSON.stringify({access_token:`graph-token-${++issued}`,expires_in:3600})});
  const graphDefault=microsoft.graph;
  microsoft.graph=(request,context)=>request.headers?.Authorization==='Bearer graph-token-1'?{status:401,body:JSON.stringify({error:{message:'AADSTS expired token'}})}:graphDefault(request,context);
  await due();
  check((await run()).result,'ok','a 401 is repeated once with a new token');
  check([tokenCalls().length,graphCalls().filter(call=>call.auth==='Bearer graph-token-1').length>=1,graphCalls().filter(call=>call.auth==='Bearer graph-token-2').length],[2,true,2],'one new token after the 401; both accounts then read with it');
  microsoft.graph=()=>({status:401,body:JSON.stringify({error:{message:'AADSTS still refused'}})});
  await due();
  check((await run()).result,'credentialRefused','401 after the retry: credentialRefused');
  check([(await userRow(a.user.id)).status,await sessions(a.user.id)>0],['active',true],'credentialRefused locks or revokes nothing');
  // Certificate assertion instead of the secret.
  reset();
  const certificate=selfSignedCertificate();
  await d.exec(sql`UPDATE entra_settings SET credential_kind='certificate',secret_enc=NULL,certificate_pem=${certificate.certificatePem},private_key_enc=${await m.mfa.encryptSecret(certificate.privateKeyPem,'entra:private-key')},certificate_thumbprint=${certificate.thumbprint},certificate_expires_at=${Date.parse('2049-12-31T23:59:59Z')},revision=2,tested_revision=2`);
  await due();
  check((await run()).result,'ok','a run with the certificate');
  const form=tokenCalls()[0];
  check([form.grant_type,form.client_assertion_type,typeof form.client_assertion,'client_secret' in form],['client_credentials','urn:ietf:params:oauth:client-assertion-type:jwt-bearer','string',false],'client-credentials token with a certificate assertion');
  await f.configure();reset();
  // The host check: login.microsoftonline.com, or graph.microsoft.com under /v1.0/ only.
  for(const url of ['https://example.com/v1.0/users','https://graph.microsoft.com/beta/users','http://graph.microsoft.com/v1.0/users','https://graph.microsoft.com:8443/v1.0/users','https://user@graph.microsoft.com/v1.0/users','https://graph.microsoft.com.evil.example/v1.0/users']){
   check(await m.oidc.entraRequest({url,method:'GET'}).then(()=>'sent',error=>error.message.startsWith('Entra requests go only to')?'refused':error.message),'refused',`host check refuses ${url}`);
  }
  await retire();
 }

 // ---- Disabled and deleted in Entra: locked ---------------------------------------------
 {
  await mapping(groupOps,'builtin-operator');
  const c=await signInAs(oid(10),[groupOps,groupUnmapped],{enabled:false});
  const del=await signInAs(oid(11),[groupOps]);directory.delete(oid(11));
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},'user',${c.user.id},'builtin-reader','global','*',0,'manual')`);
  const job=crypto.randomUUID(),terminal=crypto.randomUUID(),server=crypto.randomUUID(),at=clockNow();
  await d.exec(hasActorPrincipal
   ?sql`INSERT INTO jobs(id,server_id,action,target,created_at,actor,actor_email,actor_principal,parameters) VALUES(${job},${server},'refresh','Inventory',${at},${c.user.display_name},${c.user.auth_email},${c.user.auth_principal},'{"x":1}')`
   :sql`INSERT INTO jobs(id,server_id,action,target,created_at,actor,actor_email,parameters) VALUES(${job},${server},'refresh','Inventory',${at},${c.user.display_name},${c.user.auth_email},'{"x":1}')`);
  await d.exec(sql`INSERT INTO terminal_sessions(id,server_id,principal,state,cols,rows,created_at,last_activity,expires_at) VALUES(${terminal},${server},${c.user.auth_principal},'open',80,24,${at},${at},${at+minute})`);
  check([await sessions(c.user.id),await mfaSessions(c.user.auth_principal)>0,!!await f.viewerOf(c.browser),await rolesOf(c.user.id)],[1,true,true,[['builtin-operator','entra'],['builtin-reader','manual']]],'before: signed in with the mapped and the manual role');
  const viewer=await f.viewerOf(c.browser);
  check((await m.access.globalPermissions(viewer)).includes('terminal'),true,'before: Operator rights');
  await due();
  const result=await run();
  check([result.result,result.checked,result.locked,result.groupChanges],['ok',2,2,0],'two accounts locked');
  const row=await userRow(c.user.id);
  check([row.status,Number(row.auth_version),row.entra_checked_at!==null],['disabled',Number(c.user.auth_version)+1,true],'disabled in Entra: locked, auth_version bumped, checked');
  check([await sessions(c.user.id),await mfaSessions(c.user.auth_principal),await f.viewerOf(c.browser)],[0,0,null],'sessions and MFA sessions gone; the old cookie has no identity');
  check([await groupsOf(c.user.id),await rolesOf(c.user.id)],[[],[['builtin-reader','manual']]],'all groups and Entra roles gone, the manual role stays');
  check((await d.one(sql`SELECT state,parameters FROM jobs WHERE id=${job}`)),{state:'cancelled',parameters:'{}'},'the pending job is cancelled');
  check((await d.one(sql`SELECT state FROM terminal_sessions WHERE id=${terminal}`)).state,'closed','the open terminal is closed');
  const locked=(await auditOf('auth.entra.check.locked')).map(([actor,target])=>[actor,target]).sort((x,y)=>x[1].localeCompare(y[1]));
  check(locked,[['System',`user=${c.user.id} tenant=${tenant} object=${oid(10)} state=disabled`],['System',`user=${del.user.id} tenant=${tenant} object=${oid(11)} state=deleted`]].sort((x,y)=>x[1].localeCompare(y[1])),'auth.entra.check.locked: state=disabled and, for a 404, state=deleted');
  check([(await userRow(del.user.id)).status,await sessions(del.user.id)],['disabled',0],'deleted in Entra: locked, sessions gone');
  check((await auditOf('auth.entra.roles.sync')).filter(([,target])=>target.startsWith(`user=${c.user.id} `)).at(-1),['System',`user=${c.user.id} added= removed=builtin-operator@global`],'the role sync row of the lock');
  check(await m.access.globalPermissions(viewer),[],'the removed role grants nothing any more');
  reset();microsoft.claims={oid:oid(10),groups:[groupOps]};directory.set(oid(10),{enabled:true,groups:[groupOps]});
  check((await f.signIn()).target,'/#entra=accountDisabled','sign-in refuses the locked account');
  reset();await due();await run();
  check(userCalls().includes(oid(10)),false,'a locked account is not requested again');
  check((await userRow(c.user.id)).status,'disabled','the check never unlocks');
  await d.exec(sql`DELETE FROM entra_group_roles`);await retire();
 }

 // ---- The last Owner through an Entra mapping --------------------------------------------
 {
  await d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${owner.actor.id}`);
  await mapping(groupAdmins,'builtin-owner');
  const e=await signInAs(oid(20),[groupAdmins],{enabled:false});
  check(await rolesOf(e.user.id),[['builtin-owner','entra']],'Owner through the mapping');
  reset();await due();
  const result=await run();
  check([result.locked,result.checked],[0,1],'kept, not counted as locked');
  const row=await userRow(e.user.id);
  check([row.status,Number(row.auth_version),await sessions(e.user.id),await mfaSessions(e.user.auth_principal)],['active',Number(e.user.auth_version),0,0],'the last Owner stays active; its sessions are revoked anyway');
  check(await rolesOf(e.user.id),[['builtin-owner','entra']],'the last Owner assignment stays');
  check((await auditOf('auth.entra.check.locked')).at(-1),['System',`user=${e.user.id} tenant=${tenant} object=${oid(20)} state=disabled keptLastOwner`],'locked row with keptLastOwner');
  check((await auditOf('auth.entra.roles.sync')).at(-1),['System',`user=${e.user.id} added= removed= keptLastOwner`],'sync row with keptLastOwner');
  // The keptLastOwner rows only when the state starts (entra_kept_owner_since, docs/entra-id.md "The last Owner").
  const keptLocked=()=>auditOf('auth.entra.check.locked').then(rows=>rows.filter(([,target])=>target.startsWith(`user=${e.user.id} `)));
  const keptSync=()=>auditOf('auth.entra.roles.sync').then(rows=>rows.filter(([,target])=>target.startsWith(`user=${e.user.id} `)&&target.endsWith(' keptLastOwner')));
  const marker=async()=>{const value=(await d.one(sql`SELECT entra_kept_owner_since FROM local_users WHERE id=${e.user.id}`)).entra_kept_owner_since;return value===null?null:Number(value);};
  const lockedAt=Number((await d.one(sql`SELECT at FROM audit WHERE action='auth.entra.check.locked' ORDER BY id DESC LIMIT 1`)).at);
  check([(await keptLocked()).length,(await keptSync()).length],[1,1],'first run in the state: one locked row and one sync row');
  check([await marker(),Number((await userRow(e.user.id)).entra_checked_at)],[lockedAt,lockedAt],'the marker is the commit time of the first run');
  const addSession=async()=>{const at=clockNow();await d.exec(sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${crypto.randomUUID()},id,auth_version,${at},${at+86_400_000},${at+600_000},NULL FROM local_users WHERE id=${e.user.id}`);};
  // A later run while the state lasts: sessions end again, no new row, the marker keeps its first value.
  await addSession();check(await sessions(e.user.id),1,'a session created in between');
  reset();await due();
  const later=await run();
  check([later.checked,later.locked],[1,0],'a later run: checked, not locked');
  check([(await keptLocked()).length,(await keptSync()).length,await sessions(e.user.id)],[1,1,0],'a later run: no new row, the session is gone');
  const laterRow=await userRow(e.user.id);
  check([await marker(),laterRow.status,Number(laterRow.entra_checked_at)>lockedAt],[lockedAt,'active',true],'a later run: the marker stays, entra_checked_at moves on');
  check(await rolesOf(e.user.id),[['builtin-owner','entra']],'a later run: the Owner assignment stays');
  // A run that does not commit for the account (auth_version changed during the Graph read) changes no marker and writes no row.
  await d.exec(sql`UPDATE local_users SET entra_kept_owner_since=NULL WHERE id=${e.user.id}`);
  const fallback=microsoft.graph;
  reset();microsoft.graph=async(request,context)=>{if(context.path===`/users/${oid(20)}`)await d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${e.user.id}`);return fallback(request,context);};
  await due();
  const guarded=await run();
  check([guarded.checked,await marker(),(await keptLocked()).length,(await keptSync()).length],[0,null,1,1],'guard fails: no marker and no row');
  // Entra enables the account: the marker goes, no row for the end.
  directory.set(oid(20),{enabled:true,groups:[]});
  reset();await due();await run();
  check([await marker(),(await keptLocked()).length,(await keptSync()).length],[null,1,1],'enabled again: the marker is NULL, no row');
  // Disabled again while still the last Owner: a first run again.
  directory.set(oid(20),{enabled:false,groups:[]});
  reset();await due();await run();
  const againAt=Number((await d.one(sql`SELECT at FROM audit WHERE action='auth.entra.check.locked' ORDER BY id DESC LIMIT 1`)).at);
  check([(await keptLocked()).length,(await keptSync()).length,(await keptLocked()).at(-1)[1].endsWith(' keptLastOwner'),await marker()],[2,2,true,againAt],'disabled again: one new pair of rows and a new marker');
  // Another active direct global Owner: the account is locked, the marker goes, one locked row without keptLastOwner.
  await d.exec(sql`UPDATE local_users SET status='active' WHERE id=${owner.actor.id}`);
  reset();await due();
  check((await run()).locked,1,'locked once another Owner exists');
  check([(await userRow(e.user.id)).status,await marker()],['disabled',null],'locked: the marker is NULL');
  check([(await keptLocked()).length,(await keptLocked()).at(-1)],[3,['System',`user=${e.user.id} tenant=${tenant} object=${oid(20)} state=disabled`]],'locked: one locked row without keptLastOwner');
  await d.exec(sql`DELETE FROM entra_group_roles`);await retire();
 }

 // ---- Left a mapped group -----------------------------------------------------------------
 {
  await mapping(groupOps,'builtin-operator');
  const readers=Array.from({length:24},(_,i)=>group(100+i));
  for(const id of readers)await mapping(id,'builtin-reader');
  const mapped=[groupOps,...readers].sort(),lost=[groupOps,readers[5]].sort();
  const g=await signInAs(oid(30),[...mapped,groupUnmapped],{member:mapped.filter(id=>!lost.includes(id))});
  const h=await signInAs(oid(31),[groupOps,groupUnmapped],{member:[groupOps]});
  check((await rolesOf(g.user.id)).map(([role])=>role),['builtin-operator','builtin-reader'],'before: roles from the groups');
  const viewer=await f.viewerOf(g.browser),hChecked=(await userRow(h.user.id)).entra_checked_at;
  reset();await due();
  const auditBefore=(await f.auditRows('%')).length;
  const result=await run();
  check([result.result,result.checked,result.locked,result.groupChanges],['ok',2,0,1],'one group change');
  const asked=graphCalls().filter(call=>call.path===`/users/${oid(30)}/checkMemberGroups`);
  check([asked.every(call=>call.method==='POST'),asked.map(call=>call.body.groupIds.length)],[true,[20,5]],'25 mapped groups in batches of 20');
  check(asked.flatMap(call=>call.body.groupIds).sort(),mapped,'only the mapped stored groups are asked');
  check(graphCalls().filter(call=>call.path===`/users/${oid(31)}/checkMemberGroups`).map(call=>call.body.groupIds),[[groupOps]],'the unmapped group of another account is not asked either');
  check(await groupsOf(g.user.id),[...mapped.filter(id=>!lost.includes(id)),groupUnmapped].sort(),'the lost groups go; the unmapped stored group stays');
  check([(await rolesOf(g.user.id)).map(([role])=>role),await sessions(g.user.id),await f.viewerOf(g.browser)],[['builtin-reader'],0,null],'the Operator role and the sessions are gone');
  check((await m.access.globalPermissions(viewer)).includes('terminal'),false,'the removed role grants nothing any more');
  check([(await userRow(g.user.id)).status,(await userRow(g.user.id)).entra_checked_at!==null],['active',true],'the account stays active');
  check((await auditOf('auth.entra.check.groups')),[['System',`user=${g.user.id} object=${oid(30)} removed=${lost.join(',')}`]],'auth.entra.check.groups with the sorted removed groups');
  check((await auditOf('auth.entra.roles.sync')).at(-1),['System',`user=${g.user.id} added= removed=builtin-operator@global`],'auth.entra.roles.sync of the change');
  check([await sessions(h.user.id),!!await f.viewerOf(h.browser),await groupsOf(h.user.id),(await userRow(h.user.id)).entra_checked_at!==hChecked],[1,true,[groupOps,groupUnmapped].sort(),true],'still a member: only entra_checked_at, session alive');
  check((await f.auditRows('%')).length-auditBefore,2,'only the groups and the roles.sync row: none for the unchanged account');
  // The check never adds: a group in Graph that the account did not sign in with changes nothing.
  directory.set(oid(30),{enabled:true,groups:mapped});
  reset();await due();
  check((await run()).groupChanges,0,'the check never adds groups');
  check((await rolesOf(g.user.id)).map(([role])=>role),['builtin-reader'],'and never adds roles');
  await d.exec(sql`DELETE FROM entra_group_roles`);await retire();
 }

 // ---- Race guards ---------------------------------------------------------------------------
 {
  const r=await signInAs(oid(40),[],{enabled:false}),lockedBefore=(await auditOf('auth.entra.check.locked')).length;
  const during=action=>{const fallback=microsoft.graph;microsoft.graph=async(request,context)=>{if(context.path===`/users/${oid(40)}`)await action();return fallback(request,context);};};
  const unchanged=async label=>{
   const row=await userRow(r.user.id);
   check([row.status,row.entra_checked_at,await sessions(r.user.id)],['active',null,1],label);
  };
  // A sign-in while Graph is read wins.
  reset();during(()=>d.exec(sql`UPDATE local_users SET last_login_at=${clockNow()+1000} WHERE id=${r.user.id}`));
  await due();
  const signedIn=await run();
  check([signedIn.result,signedIn.checked,signedIn.locked,signedIn.remaining],['ok',0,0,1],'a sign-in after the Graph read: not counted, left for the next run');
  await unchanged('a sign-in after the Graph read: nothing changed');
  check((await auditOf('auth.entra.check.locked')).length,lockedBefore,'no locked row');
  // An auth_version change while Graph is read wins.
  await d.exec(sql`UPDATE local_users SET last_login_at=${clockNow()-minute} WHERE id=${r.user.id}`);
  reset();during(()=>d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${r.user.id}`));
  await due();
  check((await run()).locked,0,'an auth_version change: not locked');
  await unchanged('an auth_version change: nothing changed');
  // A settings revision change stops the run.
  reset();during(()=>d.exec(sql`UPDATE entra_settings SET revision=revision+1,tested_revision=revision+1`));
  await due();
  check(await run(),{status:'stopped'},'a new settings revision stops the run');
  await unchanged('a new settings revision: nothing changed');
  check((await checkRow()).lease_until,null,'the stopped run frees its lease');
  await f.configure();reset();await retire();
 }

 // ---- Failures: fail without change -------------------------------------------------------------
 {
  const x1=await signInAs(oid(50),[],{enabled:false}),x2=await signInAs(oid(51),[],{enabled:false});
  // The token section already failed and recovered once; only the rows of this section count.
  const failedBefore=(await auditOf('auth.entra.check.failed')).length,restoredBefore=(await auditOf('auth.entra.check.restored')).length;
  check((await checkRow()).last_result,'ok','this section starts after an ok run');
  const failedRows=async()=>(await auditOf('auth.entra.check.failed')).slice(failedBefore),restoredRows=async()=>(await auditOf('auth.entra.check.restored')).slice(restoredBefore);
  await d.exec(sql`UPDATE local_users SET entra_checked_at=NULL WHERE id=${x1.user.id}`);
  await d.exec(sql`UPDATE local_users SET entra_checked_at=1 WHERE id=${x2.user.id}`);
  const fallback=microsoft.graph;
  // x1 locks at once; x2 answers 403 a moment later: x1 stays committed, x2 is untouched.
  microsoft.graph=async(request,context)=>{if(context.path===`/users/${oid(51)}`){await new Promise(resolve=>setTimeout(resolve,300));return {status:403,body:JSON.stringify({error:{code:'Authorization_RequestDenied',message:'AADSTS Insufficient privileges'}})};}return fallback(request,context);};
  await due();
  const first=await run();
  check([first.result,first.checked,first.locked,first.remaining],['permissionMissing',1,1,1],'403: permissionMissing stops the run');
  check([(await userRow(x1.user.id)).status,(await userRow(x2.user.id)).status,await sessions(x2.user.id)],['disabled','active',1],'the earlier account stays committed; nothing changed for the other');
  check(await failedRows(),[['System','result=permissionMissing']],'one failed row');
  const row=await checkRow();
  check([row.last_result,row.lease_until,Number(row.checked_count),Number(row.locked_count),Number(row.remaining_count)],['permissionMissing',null,1,1,1],'the run row');
  await due();
  check((await run()).result,'permissionMissing','the same failure again');
  check((await failedRows()).length,1,'no second failed row for the same result');
  check([(await userRow(x2.user.id)).status,await sessions(x2.user.id)],['active',1],'repeated failures change nothing');
  const failures=[
   ['permissionMissing','200 without accountEnabled',()=>{microsoft.graph=()=>({status:200,body:JSON.stringify({id:oid(51)})});}],
   ['secretExpired','token refused AADSTS7000222',()=>{microsoft.token=()=>({status:401,body:JSON.stringify({error:'invalid_client',error_description:'AADSTS7000222: The provided client secret keys are expired.',error_codes:[7000222]})});}],
   ['credentialRefused','token refused',()=>{microsoft.token=()=>({status:400,body:JSON.stringify({error:'unauthorized_client',error_description:'AADSTS700016: Application not found.',error_codes:[700016]})});}],
   ['unavailable','429',()=>{microsoft.graph=()=>({status:429,body:'AADSTS throttled'});}],
   ['unavailable','503',()=>{microsoft.graph=()=>({status:503,body:'AADSTS busy'});}],
   ['unavailable','408',()=>{microsoft.graph=()=>({status:408,body:''});}],
   ['unavailable','network failure',()=>{microsoft.graph=()=>{throw new Error('connect ECONNRESET');};}],
   ['unavailable','token endpoint unreachable',()=>{microsoft.token=()=>{throw new Error('connect ETIMEDOUT');};}],
   ['unavailable','answer over 64 KiB',()=>{microsoft.graph=()=>({status:200,body:JSON.stringify({id:oid(51),accountEnabled:false,padding:'x'.repeat(70*1024)})});}],
  ];
  for(const [code,label,setup] of failures){
   reset();setup();await due();
   const result=await run();
   check([result.result,(await userRow(x2.user.id)).status,await sessions(x2.user.id)],[code,'active',1],`${label}: ${code}, nothing locked or revoked`);
  }
  check((await failedRows()).map(([,target])=>target),['result=permissionMissing','result=secretExpired','result=credentialRefused','result=unavailable'],'one failed row per change of the result');
  reset();await due();
  const ok=await run();
  check([ok.result,ok.locked,(await userRow(x2.user.id)).status],['ok',1,'disabled'],'the next ok run locks the account');
  check(await restoredRows(),[['System','result=ok previous=unavailable']],'restored row after the failures');
  const okRow=await checkRow();
  check([okRow.last_result,Number(okRow.last_ok_at)===Number(okRow.last_finished_at)],['ok',true],'last_ok_at on ok');
  await due();await run();
  check((await restoredRows()).length,1,'no second restored row');
  await retire();
 }

 // ---- Limits: order, other tenants, locked accounts, budget, in flight, cap --------------------------
 {
  const accounts=[];
  for(let i=0;i<6;i++)accounts.push((await signInAs(oid(60+i))).user);
  // Two never checked, then the oldest first.
  const checkedAt=[null,500,null,100,400,200];
  for(const [i,user] of accounts.entries())await d.exec(sql`UPDATE local_users SET entra_checked_at=${checkedAt[i]}::bigint WHERE id=${user.id}`);
  const locked=await signInAs(oid(70));await d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${locked.user.id}`);
  const otherOid=oid(71),otherId=crypto.randomUUID(),at=clockNow();
  await d.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at,identity_source,entra_tenant_id,entra_object_id) VALUES(${otherId},${'other-'+otherId},'','Other tenant',${`entra:${tenant2}:${otherOid}`},${'entra-'+otherId},'active',1,${at},${at},'entra',${tenant2},${otherOid})`);
  directory.set(otherOid,{enabled:false});
  // The budget: the first Graph answer moves the clock past 8 minutes.
  const start=clockNow();let fake=start,inFlight=0,most=0;
  const fallback=microsoft.graph;
  microsoft.graph=async(request,context)=>{inFlight++;most=Math.max(most,inFlight);await new Promise(resolve=>setTimeout(resolve,40));fake=start+9*minute;inFlight--;return fallback(request,context);};
  await due();
  const result=await run({time:start,clock:()=>fake});
  check([result.checked,result.remaining],[4,2],'the time budget stops the run: 4 checked, 2 remaining');
  check(Number((await checkRow()).remaining_count),2,'remaining_count stored');
  const order=[0,2,3,5].map(i=>accounts[i].entra_object_id).sort();
  check(userCalls().sort(),order,'never checked first, then the oldest');
  check([userCalls().includes(otherOid),userCalls().includes(oid(70))],[false,false],'another tenant and a locked account are not requested');
  check((await userRow(otherId)).status,'active','the account of another tenant is skipped');
  check(most<=4,true,'never more than 4 requests in flight');
  // The left-over accounts come first in the next run.
  reset();await due();microsoft.calls=[];
  const next=await run({clock:()=>clockNow()});
  check(next.checked,6,'the next run checks all');
  // At most 4 Graph requests in flight in the process, also for many parallel callers.
  inFlight=0;most=0;
  microsoft.graph=async(request,context)=>{inFlight++;most=Math.max(most,inFlight,graph.graphInFlight());await new Promise(resolve=>setTimeout(resolve,20));inFlight--;return fallback(request,context);};
  const session={tenant,clientId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',credential:{kind:'secret',secret:'client-secret-value'},revision:1,clock:clockNow};
  const states=await Promise.all(accounts.concat(accounts).map(user=>graph.graphAccountState(session,user.entra_object_id)));
  check([states.every(state=>state==='enabled'),most],[true,4],'12 parallel reads: exactly 4 in flight at most');
  check(graph.graphInFlight(),0,'nothing left in flight');
  reset();await retire();
  await d.exec(sql`DELETE FROM local_users WHERE id=${otherId}`);
 }

 // ---- The cap of 5000 accounts per run -----------------------------------------------------------
 {
  const at=clockNow();
  await d.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at,identity_source,entra_tenant_id,entra_object_id)
   SELECT 'cap-'||n,'cap-'||n,'','Cap '||n,'entra:'||${tenant}::text||':'||o,'cap-'||n||'@check.test','active',1,${at}::bigint,${at}::bigint,'entra',${tenant}::text,o
   FROM (SELECT n,'d0d0d0d0-0000-4000-8000-'||lpad(n::text,12,'0') AS o FROM generate_series(1,5001) n) s`);
  let graphReads=0;
  microsoft.graph=(request,{path})=>{graphReads++;return {status:200,body:JSON.stringify({id:path.slice(7),accountEnabled:true})};};
  await due();
  const result=await run();
  check([result.result,result.checked,result.remaining,graphReads],['ok',5000,1,5000],'at most 5000 accounts per run; the rest is remaining');
  await d.exec(sql`DELETE FROM local_users WHERE id LIKE 'cap-%'`);
  reset();
 }

 // ---- No secret, token or Graph text anywhere -----------------------------------------------------
 {
  const stored=JSON.stringify([await checkRow(),await f.auditRows('%')]);
  for(const secret of ['client-secret-value','graph-token','AADSTS','Insufficient','client_assertion','Bearer'])check([stored.includes(secret),logged.some(line=>line.includes(secret))],[false,false],`no "${secret}" in stored values or logs`);
 }
 console.log(`PASS entra directory check (${checks} checks): lease, token reuse and 401 retry, host check, lock of disabled and deleted accounts, last Owner, lost groups, race guards, failures without change, order, budget, cap and requests in flight.`);
}finally{await d.close();}
