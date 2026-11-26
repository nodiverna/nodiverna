// Actual source authorization SQL and IAM mutations against an isolated PostgreSQL test database.
// No request reaches a production portal or a Windows device.
import {pureModule} from '../support/pure-modules.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {sourceDatabase,inTransaction,dbModule,sourceLoader} from '../support/source-database.mjs';
import * as crossCustomerRight from '../../lib/cross-customer-right.ts';
import {compile,dbNow,sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {runtimePath} from '../support/runtime-path.mjs';
const require=createRequire(import.meta.url);
const d=await sourceDatabase();
const uuid=()=>crypto.randomUUID(),token=()=>crypto.randomBytes(32).toString('hex');
const HttpError=realHttpError;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
try{
 let beforeBatch=null;const db=hookDatabase(d,{transaction:async()=>{const hook=beforeBatch;beforeBatch=null;if(hook)await hook();}});
 const server={db:()=>db,guid:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),HttpError,now:()=>Date.now(),random:token,hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),config:()=>'',log:async(actor,action,target)=>d.exec(sql`INSERT INTO audit(at,actor,action,target) VALUES(${Date.now()},${actor},${action},${target})`)};
 const load=(file,imports)=>{const fixture={exports:{}};new Function('require','exports','module',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>name in imports?imports[name]:pureModule(name)??(name==='./db'||name==='../db'||name==='../../db'?dbModule():require(runtimePath(name))),fixture.exports,fixture);return fixture.exports;};
 // The error catalog and trigger registry import nothing server-only and load as they are.
 const errorCodes=load('lib/errors/codes.ts',{}),dbCodes=load('lib/server/errors/db-codes.ts',{'../../errors/codes':errorCodes}),errors={'../errors/codes':errorCodes,'../../errors/codes':errorCodes,'./errors/db-codes':dbCodes,'../errors/db-codes':dbCodes};
 const access=load('lib/server/identity/access.ts',{'../context':server,'../../cross-customer-right':crossCustomerRight}),features=load('lib/server/identity/feature-authorization.ts',{'./access':access}),policy=load('lib/server/identity/policy/can.ts',{'../access':access,'../feature-authorization':features,'../../context':server}),audit=load('lib/server/audit.ts',{'./context':server}),emergency=load('lib/server/identity/entra/emergency.ts',{'../../audit':audit}),brand=load('lib/brand.ts',{}),mfa=load('lib/server/identity/mfa.ts',{'../context':server,'./context':server,'./access':access,'./identity/access':access,'../../brand':brand,'./entra/emergency':emergency,'./mfa-uri':load('lib/server/identity/mfa-uri.ts',{'../../brand':brand}),'./session-settings':load('lib/server/identity/session-settings.ts',{'../context':server,'./context':server,'./access':access,'./identity/access':access,'../audit':audit,'./audit':audit,'./feature-authorization':features,'./policy/can':policy,'./identity/policy/can':policy}),'../security-commit':load('lib/server/security-commit.ts',{'./context':server,'./audit':audit})}),groups=load('lib/server/devices/device-groups.ts',{'../context':server,...errors}),catalogOwnership=load('lib/server/catalog-ownership.ts',{'./context':server,'./identity/access':access,'./identity/policy/can':policy,...errors,'./identity/customers':load('lib/server/identity/customers.ts',{'../context':server,'./access':access,'./policy/can':policy,...errors,'../../default-customer':load('lib/default-customer.ts',{})})}),rbacImports={'../../step-up':load('lib/step-up.ts',{}),'../context':server,'./context':server,'./identity/policy/can':policy,'./policy/can':policy,'../audit':audit,'./audit':audit,'./entra/emergency':emergency,'./identity/access':access,'./access':access,'./mfa':mfa,'../devices/device-groups':groups,'../catalog-ownership':catalogOwnership,...errors},rbac=load('lib/server/identity/rbac.ts',rbacImports);
 const time=Date.now(),groupA=uuid(),groupB=uuid(),deviceA=uuid(),deviceB=uuid(),deviceC=uuid(),revokedDevice=uuid();
 for(const [id,name] of [[groupA,'Production'],[groupB,'Development']])await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at) VALUES(${id},${name},${'Fixture'},${time})`);
 for(const [id,name,revoked] of [[deviceA,'A',0],[deviceB,'B',0],[deviceC,'C',0],[revokedDevice,'Revoked',1]])await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,revoked) VALUES(${id},${name},${token()},${time},${revoked})`);
 await inTransaction(d,[sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${deviceA},${groupA})`,sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${deviceB},${groupB})`]);
 const users={};
 for(const [name,status] of [['owner','active'],['secondOwner','active'],['operator','active'],['viewer','active'],['revoked','disabled'],['accessAdmin','active'],['newUser','invited']]){
  const id=uuid(),email=name==='newUser'?id+'@local.serverdesk.invalid':name.toLowerCase()+'@rbac.test',principal='private:'+email;
  users[name]={id,userId:id,label:email,principal,username:name.toLowerCase(),displayName:name,authorization:{authVersion:1}};
  await d.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,created_at,updated_at) VALUES(${id},${name.toLowerCase()},${name+'@public.test'},${name},${principal},${email},${status},${time},${time})`);
 }
 // The six built-in roles come from a runtime seed. Concurrent
 // calls, also from separate module instances (processes), create each role once,
 // and the seed reads no account and imports no grant.
 const instances=[rbac,load('lib/server/identity/rbac.ts',rbacImports),load('lib/server/identity/rbac.ts',rbacImports)];
 await Promise.all(instances.flatMap(instance=>[instance.ensureBuiltinRoles(),instance.ensureBuiltinRoles()]));await rbac.ensureBuiltinRoles();
 const seeded=(await d.query(sql`SELECT id,name,description,permissions,builtin FROM rbac_roles ORDER BY id`)).map(row=>({...row}));
 check(seeded,rbac.builtinRoles().map(role=>({id:role.id,name:role.name,description:role.description,permissions:JSON.stringify(role.permissions),builtin:1})).sort((x,y)=>x.id<y.id?-1:1),'exactly the six built-in roles with their ids, names, descriptions and permissions');
 check(rbac.builtinRoles().map(role=>role.id),['builtin-owner','builtin-reader','builtin-operator','builtin-device-administrator','builtin-user-access-administrator','builtin-portal-operator'],'the built-in role ids stay');
 // Permission names are catalog keys (permission.<id>, the cross-customer right crossCustomer.right), in the console language.
 const i18n=sourceLoader(),en=i18n('lib/i18n/messages/en.ts').default,de=i18n('lib/i18n/messages/de.ts').default,{translate}=i18n('lib/i18n/translate.ts');
 const definitions=[...access.permissionDefinitions,...access.portalPermissionDefinitions],names=(id,locale)=>translate(locale,definitions.find(entry=>entry.id===id)?.labelKey);
 check(definitions.map(entry=>Object.keys(entry).sort()),definitions.map(()=>['id','labelKey']),'every right is {id,labelKey} with no label');
 check(definitions.filter(entry=>!(entry.labelKey in en)||!(entry.labelKey in de)||translate('en',entry.labelKey)===translate('de',entry.labelKey)).map(entry=>entry.id),[],'each labelKey is in en and de, with an English and a German text');
 check(definitions.filter(entry=>entry.labelKey!==(entry.id==='portal.msp.crossCustomer'?'crossCustomer.right':'permission.'+entry.id)).map(entry=>entry.id),[],'the key is permission.<id>, crossCustomer.right for the cross-customer right');
 check(access.permissionDefinitions.map(entry=>entry.id),['view','diagnose','security.events','files.read','files.write','terminal','rdp','runbooks','runbooks.read','runbooks.execute','runbooks.outputs','runbooks.manage','manage','update','drift.read','drift.contents','drift.manage','desired.read','desired.manage','desired.apply','groups.manage','alerts.manage','defender.read','defender.control','plugins.manage','dhcp.read','dhcp.manage','dns.read','dns.manage'],'the device right order stays, as fresh seeds and migrations store it');
 check(access.portalPermissionDefinitions.map(entry=>entry.id),['portal.roleAssignments.manage','portal.users.manage','portal.userGroups.manage','portal.roles.manage','portal.operator','portal.notifications.manage','portal.msp.crossCustomer'],'the portal right order stays');
 check([access.allPermissions,access.allPortalPermissions],[access.permissionDefinitions.map(entry=>entry.id),access.portalPermissionDefinitions.map(entry=>entry.id)],'allPermissions and allPortalPermissions follow the definitions');
 for(const source of ['lib/server/identity/access.ts','lib/cross-customer-right.ts']){const text=fs.readFileSync(source,'utf8');check([/[äöüÄÖÜß]/.test(text),text.includes("label:'"),text.includes('crossCustomerPermissionLabel=')],[false,false,false],source+' holds no German permission text');}
 // Alert rules: alerts.manage is a device right of Operator and Device Administrator, not of Reader.
 check([names('alerts.manage','en'),names('alerts.manage','de')],['Manage alert rules and alarms','Alarmregeln und Alarme verwalten'],'alerts.manage is a device right with its name for rules and alarms');
 check(['builtin-reader','builtin-operator','builtin-device-administrator'].map(id=>JSON.parse(seeded.find(role=>role.id===id).permissions).includes('alerts.manage')),[false,true,true],'alerts.manage in Operator and Device Administrator, not in Reader');
 check(access.roleGrantsDeviceRight('["alerts.manage"]'),true,'a customer role may hold alerts.manage');
 // Microsoft Defender (agent 4.14.0): defender.read for Reader, both rights for Operator and Device Administrator.
 check(access.permissionDefinitions.filter(entry=>entry.id.startsWith('defender.')).map(entry=>[entry.id,names(entry.id,'en'),names(entry.id,'de')]),[['defender.read','View Microsoft Defender','Microsoft Defender ansehen'],['defender.control','Control Microsoft Defender','Microsoft Defender steuern']],'the two Defender device rights with their names');
 check([access.roleGrantsDeviceRight('["defender.read"]'),access.roleGrantsDeviceRight('["defender.control"]')],[true,true],'a customer role may hold both Defender rights');
 check(Object.fromEntries(rbac.builtinRoles().map(role=>[role.id,['defender.read','defender.control'].filter(right=>role.permissions.includes(right))])),{'builtin-owner':[],'builtin-reader':['defender.read'],'builtin-operator':['defender.read','defender.control'],'builtin-device-administrator':['defender.read','defender.control'],'builtin-user-access-administrator':[],'builtin-portal-operator':[]},'the built-in role lists (Owner through *)');
 check(['builtin-reader','builtin-operator','builtin-device-administrator'].map(id=>JSON.parse(seeded.find(role=>role.id===id).permissions).filter(right=>right.startsWith('defender.'))),[['defender.read'],['defender.read','defender.control'],['defender.read','defender.control']],'the seeded rows hold the Defender rights');
 check([access.rolePermissions.viewer.includes('defender.read'),access.rolePermissions.viewer.includes('defender.control'),access.rolePermissions.operator.includes('defender.control'),access.rolePermissions.admin.includes('defender.control')],[true,false,true,true],'the grant ceilings follow the built-in roles');
 // Extensions: five device rights; Reader reads DHCP and DNS, Operator and Device Administrator hold all five.
 const serverRoleRights=['plugins.manage','dhcp.read','dhcp.manage','dns.read','dns.manage'];
 check(serverRoleRights.map(id=>access.permissionDefinitions.some(entry=>entry.id===id)&&[names(id,'en'),names(id,'de')]),[['Manage extensions','Erweiterungen installieren und entfernen'],['View DHCP','DHCP ansehen'],['Manage DHCP','DHCP verwalten'],['View DNS','DNS ansehen'],['Manage DNS','DNS verwalten']],'the five server role rights with their names');
 check(['builtin-reader','builtin-operator','builtin-device-administrator'].map(id=>serverRoleRights.filter(right=>JSON.parse(seeded.find(role=>role.id===id).permissions).includes(right))),[['dhcp.read','dns.read'],serverRoleRights,serverRoleRights],'Reader: dhcp.read and dns.read; Operator and Device Administrator: all five');
 check(serverRoleRights.map(right=>access.roleGrantsDeviceRight(JSON.stringify([right]))),[true,true,true,true,true],'a customer role may hold each of them');
 check(JSON.parse(seeded.find(role=>role.id==='builtin-owner').permissions),['*']);check(JSON.parse(seeded.find(role=>role.id==='builtin-portal-operator').permissions),['portal.operator']);
 // Notification channels: a global portal right, held by Owners through '*', in no other built-in role.
 check(access.portalPermissionDefinitions.some(entry=>entry.id==='portal.notifications.manage')&&[names('portal.notifications.manage','en'),names('portal.notifications.manage','de')],['Manage notification channels','Benachrichtigungskanäle verwalten'],'portal.notifications.manage is a portal right with its name');
 check(access.permissionDefinitions.some(entry=>entry.id==='portal.notifications.manage'),false,'it is no device right');
 check(seeded.filter(role=>JSON.parse(role.permissions).includes('portal.notifications.manage')).map(role=>role.id),[],'no built-in role lists it; Owners hold it through *');
 check((await d.one(sql`SELECT count(*) AS n FROM role_assignments`)).n,0,'the seed assigns nothing');
 await d.exec(sql`UPDATE rbac_roles SET description='Edited' WHERE id='builtin-reader'`);await load('lib/server/identity/rbac.ts',rbacImports).ensureBuiltinRoles();
 check((await d.one(sql`SELECT description FROM rbac_roles WHERE id='builtin-reader'`)).description,'Edited','a later seed never changes an existing role');
 await d.exec(sql`UPDATE rbac_roles SET description=${rbac.builtinRoles()[1].description} WHERE id='builtin-reader'`);
 // Fixture authority as explicit assignments: two global Owners, a disabled reader
 // and a devicegroup role for the operator.
 const operatorRole=uuid(),operatorGrant=uuid();
 await inTransaction(d,[
  ...[users.owner,users.secondOwner].map(user=>sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${user.id},'builtin-owner','global','*',${time},'fixture')`),
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${users.revoked.id},'builtin-reader','global','*',${time},'fixture')`,
  sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${operatorRole},'Group operator','',${JSON.stringify(['view','terminal','manage','runbooks','groups.manage'])},0,${time})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${operatorGrant},'user',${users.operator.id},${operatorRole},'devicegroup',${groupA},${time},'fixture')`,
 ]);
 check(await access.allowedDeviceIds(users.operator,'terminal'),[deviceA],'a devicegroup role grants its devices');
 check((await access.groupPermissions(users.operator,groupA)).includes('groups.manage'),true,'a devicegroup role delegates group administration');
 check(await access.allowedDeviceIds(users.revoked),[],'a disabled account receives no authority');
 check(await policy.can(users.owner,'instance.owner'),true);check(await policy.can(users.operator,'instance.owner'),false,'a devicegroup role is no Owner');
 await d.exec(sql`UPDATE local_users SET username=${'renamed'},email=${'new-contact@public.test'},display_name=${'New display name'} WHERE id=${users.operator.id}`);check(await access.allowedDeviceIds(users.operator,'terminal'),[deviceA],'mutable profile fields do not change authorization identity');
 // A viewer without an authorization stamp fails every write guard.
 const writes=async viewer=>{const guards=[access.viewerWriteGuard(viewer),features.featureWriteGuard(viewer,sql`TRUE`),policy.viewerCanSql(viewer,'instance.owner')];return Promise.all(guards.map(async guard=>(await d.one(sql`SELECT (${guard}) AS allowed`)).allowed?1:0));};
 check(await writes(users.owner),[1,1,1],'a stamped Owner passes the write guards');
 const unstamped={...users.owner};delete unstamped.authorization;check(compile(access.viewerWriteGuard(unstamped)),{text:'FALSE',params:[]},'no stamp, no write');check(await writes(unstamped),[0,0,0],'a viewer without a stamp fails every write guard');
 check(await writes({...users.owner,authorization:{authVersion:2}}),[0,0,0],'a stale account version fails every write guard');

 const sessions=new Map();async function fresh(user){
  let session=sessions.get(user.id);if(!session){session={mfa:token(),primary:token()};sessions.set(user.id,session);await d.exec(sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${user.principal},'fixture','[]',0,${Date.now()}) ON CONFLICT(principal) DO NOTHING`);}
  const at=Date.now();await d.exec(sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at) VALUES(${session.mfa},${user.principal},${at},${at},${at+3_600_000},${at+86_400_000}) ON CONFLICT(token_hash) DO UPDATE SET idle_expires_at=excluded.idle_expires_at,expires_at=excluded.expires_at`);
  await d.exec(sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${session.primary},id,auth_version,${at},${at+86_400_000},${at+600_000},${session.mfa} FROM local_users WHERE id=${user.id} ON CONFLICT(token_hash) DO UPDATE SET auth_version=excluded.auth_version,expires_at=excluded.expires_at,mfa_hash=excluded.mfa_hash`);
  const proofToken=token();await d.exec(sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${proofToken},${user.principal},${session.mfa},${at+300_000})`);
  const live=sql`EXISTS (SELECT 1 FROM mfa_management_proofs p JOIN mfa_sessions s ON s.token_hash = p.session_hash AND s.principal = p.principal WHERE p.token_hash = ${proofToken} AND p.principal = ${user.principal} AND p.session_hash = ${session.mfa} AND p.expires_at > ${at} AND s.idle_expires_at > ${at} AND s.expires_at > ${at})`;
  return {tokenHash:proofToken,key:user.principal,sessionHash:session.mfa,guard:sql`(${live}) AND EXISTS (SELECT 1 FROM local_auth_sessions primary_session JOIN local_users active_user ON active_user.id=primary_session.user_id AND active_user.auth_version=primary_session.auth_version WHERE primary_session.token_hash=${session.primary} AND active_user.status='active' AND primary_session.mfa_hash=${session.mfa}) AND EXISTS (SELECT 1 FROM mfa_management_proofs fresh_proof WHERE fresh_proof.token_hash=${proofToken} AND fresh_proof.expires_at>${dbNow})`};
 }
 const mutate=async(payload,user=users.owner,proof=null)=>rbac.manageRbac(user,payload,proof??await fresh(user));
 const permission=async(user,device,right)=>{const guard=access.devicePermissionGuard(sql`target.server_id`,sql`target.principal`,right);return (await d.one(sql`SELECT (${guard}) AS permitted FROM (SELECT ${device}::text AS server_id,${user.principal}::text AS principal) target`)).permitted?1:0;};
 const {id:userGroup}=await mutate({action:'create-group',name:'Operations',description:'Group grants'});
 await mutate({action:'add-assignment',subjectType:'group',subjectId:userGroup,roleId:'builtin-operator',scopeType:'devicegroup',scopeId:groupB});
 check(await permission(users.viewer,deviceB,'terminal'),0,'assignment alone does not grant a nonmember');await mutate({action:'add-member',groupId:userGroup,userId:users.viewer.id});check(await permission(users.viewer,deviceB,'terminal'),1,'group membership adds inherited devicegroup rights');check(await permission(users.viewer,deviceA,'terminal'),0,'group grant cannot cross devicegroup scope');
 await mutate({action:'remove-member',groupId:userGroup,userId:users.viewer.id});check(await permission(users.viewer,deviceB,'terminal'),0,'live SQL immediately observes group member withdrawal');
 const direct=await mutate({action:'add-assignment',subjectType:'user',subjectId:users.viewer.id,roleId:'builtin-reader',scopeType:'device',scopeId:deviceC});check(await permission(users.viewer,deviceC,'view'),1,'direct device scope supported');check(await permission(users.viewer,deviceB,'view'),0,'direct device does not grant sibling scope');check((await access.groupPermissions(users.viewer,groupB)).length,0,'direct device grants cannot administer containing group');
 await mutate({action:'delete-assignment',id:direct.id});
 const globalReader=await mutate({action:'add-assignment',subjectType:'user',subjectId:users.viewer.id,roleId:'builtin-reader',scopeType:'global',scopeId:'*'});check((await access.allowedDeviceIds(users.viewer)).sort(),[deviceA,deviceB,deviceC].sort(),'global scope inherits all active devices');check(await permission(users.viewer,revokedDevice,'view'),0,'revoked device excluded even for inherited rights');
 await mutate({action:'delete-assignment',id:globalReader.id});
 const scopedOwner=await mutate({action:'add-assignment',subjectType:'user',subjectId:users.viewer.id,roleId:'builtin-owner',scopeType:'devicegroup',scopeId:groupB});check(await policy.can({...users.viewer},'instance.owner'),false,'scoped Owner never becomes a global Owner');check(await access.hasGlobalPermission(users.viewer,'portal.users.manage'),false,'scoped Owner cannot manage portal users');check(await permission(users.viewer,deviceB,'terminal'),1,'scoped Owner has all device functions');await mutate({action:'delete-assignment',id:scopedOwner.id});
 const delegated=await mutate({action:'add-assignment',subjectType:'user',subjectId:users.accessAdmin.id,roleId:'builtin-user-access-administrator',scopeType:'global',scopeId:'*'});check(await policy.can({...users.accessAdmin},'instance.owner'),false,'Access Administrator is no Owner');check(await access.allowedDeviceIds(users.accessAdmin),[],'Access Administrator has no implicit device data access');
 const staleProof=await fresh(users.accessAdmin);beforeBatch=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${delegated.id}`);await assert.rejects(()=>mutate({action:'create-role',name:'Denied after revoke',permissions:['terminal']},users.accessAdmin,staleProof),e=>e.status===403);check(await d.one(sql`SELECT id FROM rbac_roles WHERE name='Denied after revoke'`),null,'captured management authority cannot survive a concurrent revocation');
 const groupManagerRole=await mutate({action:'create-role',name:'Group metadata administrator',permissions:['portal.userGroups.manage']}),roleManagerRole=await mutate({action:'create-role',name:'Role definition administrator',permissions:['portal.roles.manage']});
 await mutate({action:'add-assignment',subjectType:'user',subjectId:users.accessAdmin.id,roleId:groupManagerRole.id,scopeType:'global',scopeId:'*'});
 const privilegedGroup=await mutate({action:'create-group',name:'Owners'});await mutate({action:'add-assignment',subjectType:'group',subjectId:privilegedGroup.id,roleId:'builtin-owner',scopeType:'global',scopeId:'*'});
 await assert.rejects(()=>mutate({action:'add-member',groupId:privilegedGroup.id,userId:users.accessAdmin.id},users.accessAdmin),e=>e.status===403);check(await access.hasGlobalPermission(users.accessAdmin,'portal.roleAssignments.manage'),false,'group metadata administrator cannot add self to an Owner group');
 await mutate({action:'update-group',id:privilegedGroup.id,name:'Owners',description:'Inactive privilege',enabled:false});await assert.rejects(()=>mutate({action:'update-group',id:privilegedGroup.id,name:'Owners',enabled:true},users.accessAdmin),e=>e.status===403);check((await d.one(sql`SELECT enabled FROM user_groups WHERE id=${privilegedGroup.id}`)).enabled,0,'group metadata administrator cannot activate an assigned privileged group');
 const unassignedGroup=await mutate({action:'create-group',name:'Unassigned group'},users.accessAdmin);await mutate({action:'add-member',groupId:unassignedGroup.id,userId:users.accessAdmin.id},users.accessAdmin);await mutate({action:'add-member',groupId:unassignedGroup.id,userId:users.accessAdmin.id},users.accessAdmin);check((await d.one(sql`SELECT count(*) AS n FROM user_group_members WHERE group_id=${unassignedGroup.id} AND user_id=${users.accessAdmin.id}`)).n,1,'unassigned group membership is allowed and idempotent');
 await d.exec(sql`INSERT INTO user_group_members(group_id,user_id) VALUES(${unassignedGroup.id},${users.revoked.id})`);await mutate({action:'remove-member',groupId:unassignedGroup.id,userId:users.revoked.id},users.accessAdmin);check(await d.one(sql`SELECT user_id FROM user_group_members WHERE group_id=${unassignedGroup.id} AND user_id=${users.revoked.id}`),null,'disabled users can be removed from group membership');
 await mutate({action:'add-assignment',subjectType:'user',subjectId:users.accessAdmin.id,roleId:roleManagerRole.id,scopeType:'global',scopeId:'*'});
 const ownRole=await mutate({action:'create-role',name:'Role metadata privileges',permissions:['portal.roles.manage']});await mutate({action:'add-assignment',subjectType:'user',subjectId:users.accessAdmin.id,roleId:ownRole.id,scopeType:'global',scopeId:'*'});await assert.rejects(()=>mutate({action:'update-role',id:ownRole.id,name:'Role metadata privileges',permissions:['portal.roles.manage','portal.roleAssignments.manage']},users.accessAdmin),e=>e.status===403);check(await access.hasGlobalPermission(users.accessAdmin,'portal.roleAssignments.manage'),false,'role definition administrator cannot expand an assigned role into role assignment authority');
 const proof=await fresh(users.owner),newRole=await mutate({action:'create-role',name:'File readers',permissions:['view','files.read']},users.owner,proof);await assert.rejects(()=>mutate({action:'create-role',name:'Proof replay',permissions:['terminal']},users.owner,proof),e=>e.status===403);check(await d.one(sql`SELECT id FROM rbac_roles WHERE name='Proof replay'`),null,'single-use management proof cannot authorize a second mutation');
 const expired=await fresh(users.owner);beforeBatch=()=>d.exec(sql`UPDATE mfa_management_proofs SET expires_at=${Date.now()-10} WHERE token_hash=${expired.tokenHash}`);await assert.rejects(()=>mutate({action:'create-role',name:'Expired proof',permissions:['terminal']},users.owner,expired),e=>e.status===403);check(await d.one(sql`SELECT id FROM rbac_roles WHERE name='Expired proof'`),null,'statement clock rejects a proof that expired after its initial read');
 await mutate({action:'add-assignment',subjectType:'user',subjectId:users.viewer.id,roleId:newRole.id,scopeType:'devicegroup',scopeId:groupA});check(await permission(users.viewer,deviceA,'files.read'),1,'custom role permission initially applies');await mutate({action:'update-role',id:newRole.id,name:'File readers',permissions:['view']});check(await permission(users.viewer,deviceA,'files.read'),0,'role edits affect current authorization without cached permissions');await assert.rejects(()=>mutate({action:'delete-role',id:newRole.id}),e=>e.status===409);await assert.rejects(()=>mutate({action:'update-role',id:'builtin-owner',name:'Broken',permissions:['view']}),e=>e.status===400);await assert.rejects(()=>mutate({action:'create-role',name:'Wildcard',permissions:['*']}),e=>e.status===400);
 const owners=(await d.query(sql`SELECT id,principal_id FROM role_assignments WHERE role_id='builtin-owner' AND scope_type='global' AND principal_type='user'`));await mutate({action:'delete-assignment',id:owners.find(a=>a.principal_id===users.secondOwner.id).id});await assert.rejects(()=>mutate({action:'delete-assignment',id:owners.find(a=>a.principal_id===users.owner.id).id}),e=>e.status===409);check((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE role_id='builtin-owner' AND scope_type='global' AND principal_type='user'`)).n,1,'last active direct global Owner cannot be removed');
 const fence=access.lastOwnerGuard(users.owner.id);check((await d.one(sql`SELECT (${fence}) AS permitted`)).permitted?1:0,0,'account disable fence protects the last Owner');
 await mutate({action:'add-assignment',subjectType:'user',subjectId:users.newUser.id,roleId:'builtin-reader',scopeType:'devicegroup',scopeId:groupB});check(await permission(users.newUser,deviceB,'view'),0,'invitation does not authorize data before activation');await d.exec(sql`UPDATE local_users SET status='active' WHERE id=${users.newUser.id}`);check(await permission(users.newUser,deviceB,'view'),1,'activation releases explicit preassigned rights');
 const data=await rbac.rbacData(users.owner);check(data.users.find(u=>u.id===users.newUser.id).username,'newuser','IAM directory uses actual profile fields');check(JSON.stringify(data.users).includes(users.newUser.label),false,'generated internal identity aliases never leak through IAM DTO');
 // Inherited assignments of a device or group, read through the scope chain of lib/server/identity/access.ts.
 const groupA1=uuid(),deviceA1=uuid();
 await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at,parent_id) VALUES(${groupA1},${'Production child'},${'Fixture'},${time},${groupA})`);
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,revoked) VALUES(${deviceA1},${'A1'},${token()},${time},0)`);
 await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${deviceA1},${groupA1})`);
 const reader=scope=>mutate({action:'add-assignment',subjectType:'user',subjectId:users.viewer.id,roleId:'builtin-reader',...scope});
 const onGlobal=await reader({scopeType:'global',scopeId:'*'}),onGroupA=await reader({scopeType:'devicegroup',scopeId:groupA}),onGroupA1=await reader({scopeType:'devicegroup',scopeId:groupA1}),onDevice=await reader({scopeType:'device',scopeId:deviceA1});
 const ids=list=>list.map(entry=>entry.assignmentId);
 // The effective flag, read independently from the same answer. While only the
 // default customer exists there is no customer reason: a role without device rights, an
 // account that is not active, a disabled or an empty user group.
 const flags=(data,assignment)=>{
  const role=data.roles.find(entry=>entry.id===assignment.roleId),deviceRights=data.permissions.filter(entry=>!entry.id.startsWith('portal.')).map(entry=>entry.id);
  if(!role.permissions.some(right=>right==='*'||deviceRights.includes(right)))return {effective:false,reason:'role'};
  const active=id=>data.users.find(user=>user.id===id)?.status==='active';
  if(assignment.subjectType==='user')return active(assignment.subjectId)?{effective:true}:{effective:false,reason:'user-inactive'};
  const group=data.userGroups.find(entry=>entry.id===assignment.subjectId);
  return !group?.enabled?{effective:false,reason:'group-disabled'}:group.userIds.some(active)?{effective:true}:{effective:false,reason:'group-empty'};
 };
 const chain=(data,...origins)=>origins.flatMap(origin=>data.assignments.filter(assignment=>origin==='*'?assignment.scopeType==='global':assignment.scopeType==='devicegroup'&&assignment.scopeId===origin).map(assignment=>({assignmentId:assignment.id,originType:assignment.scopeType,originId:assignment.scopeId,...flags(data,assignment)})));
 let scoped=await rbac.rbacData(users.owner,{type:'device',id:deviceA1});
 check(scoped.inherited,chain(scoped,groupA1,groupA,'*'),'device inherits from its group, the parent group and Alle Geräte, nearest first, created_at DESC within one origin');
 check([onGroupA1.id,onGroupA.id,onGlobal.id].map(id=>ids(scoped.inherited).indexOf(id)).every((index,n,all)=>index>=0&&(n===0||index>all[n-1])),true,'the new group, parent and global assignments appear in this order');
 check(scoped.inherited.find(entry=>entry.assignmentId===onGroupA.id),{assignmentId:onGroupA.id,originType:'devicegroup',originId:groupA,effective:true},'origin type and id name the parent group');
 check(scoped.inherited.find(entry=>entry.assignmentId===onGlobal.id),{assignmentId:onGlobal.id,originType:'global',originId:'*',effective:true},'origin type and id name Alle Geräte');
 const ownGlobal=scoped.assignments.find(assignment=>assignment.subjectType==='user'&&assignment.subjectId===users.owner.id&&assignment.roleId==='builtin-owner'&&assignment.scopeType==='global');
 check(scoped.inherited.find(entry=>entry.assignmentId===ownGlobal.id),{assignmentId:ownGlobal.id,originType:'global',originId:'*',effective:true},'with only the default customer the own global Owner entry is effective');
 check(scoped.inherited.some(entry=>entry.reason==='role')&&scoped.inherited.every(entry=>entry.effective===!('reason' in entry)),true,'a portal-only role is not effective; only non-effective entries carry a reason');
 check(scoped.inherited.some(entry=>['user-customer','group-customer'].includes(entry.reason)),false,'with only the default customer no entry has a customer reason');
 check(ids(scoped.inherited).includes(onDevice.id),false,'the device assignment itself is direct, not inherited');
 check(scoped.inherited.every(entry=>scoped.assignments.some(assignment=>assignment.id===entry.assignmentId)),true,'every inherited entry is in assignments');
 scoped=await rbac.rbacData(users.owner,{type:'devicegroup',id:groupA1});
 check(scoped.inherited,chain(scoped,groupA,'*'),'child group inherits from its parent and Alle Geräte');
 check(ids(scoped.inherited).includes(onGroupA1.id),false,'the group assignment itself is direct, not inherited');
 check(ids(scoped.inherited).includes(onDevice.id),false,'device assignments are never inherited by a group');
 scoped=await rbac.rbacData(users.owner,{type:'devicegroup',id:groupA});
 check(scoped.inherited,chain(scoped,'*'),'root group inherits only the global assignments');
 scoped=await rbac.rbacData(users.owner,{type:'device',id:deviceC});
 check(scoped.inherited,chain(scoped,'*'),'device without a group inherits only the global assignments');
 check('inherited' in await rbac.rbacData(users.owner),false,'without a scope the answer has no inherited key');
 check('inherited' in await rbac.rbacData(users.owner,{type:'global',id:'*'}),false,'the global scope has no inherited key');
 for(const [type,id,label] of [['device',revokedDevice,'revoked device'],['device',uuid(),'unknown device'],['devicegroup',uuid(),'unknown group'],['device','not-a-guid','non-GUID device id'],['devicegroup',"' OR 1=1 --",'non-GUID group id']])check((await rbac.rbacData(users.owner,{type,id})).inherited,[],label+' inherits nothing');
 const route=load('app/api/rbac/route.ts',{'@/lib/server/context':{body:async()=>({}),failure:e=>{throw e;},requireViewer:async()=>users.owner,sameOrigin:()=>{}},'@/lib/server/identity/rbac':rbac});
 const answer=async query=>(await route.GET(new Request('http://portal.test/api/rbac'+query))).json();
 check(ids((await answer(`?scopeType=device&scopeId=${deviceA1}`)).inherited).includes(onGroupA.id),true,'GET reads scopeType and scopeId from the query');
 check('inherited' in await answer(''),false,'GET without query parameters is unchanged');
 check('inherited' in await answer(`?scopeType=device`),false,'GET with only one of the two parameters is unchanged');
 check('inherited' in await answer('?scopeType=global&scopeId=*'),false,'GET with the global scope is unchanged');
 await mutate({action:'delete-assignment',id:onGroupA.id});
 check(ids((await rbac.rbacData(users.owner,{type:'device',id:deviceA1})).inherited).includes(onGroupA.id),false,'an assignment removed on the parent group leaves the device list at once');
 check(ids((await rbac.rbacData(users.owner,{type:'devicegroup',id:groupA1})).inherited).includes(onGroupA.id),false,'an assignment removed on the parent group leaves the child group list at once');
 for(const assignment of [onGlobal,onGroupA1,onDevice])await mutate({action:'delete-assignment',id:assignment.id});
 console.log('PASS local RBAC: '+checks+' authorization, migration, scope, group, role, proof-race and last-Owner checks.');
}finally{await d.close();}
