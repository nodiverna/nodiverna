// Tags of devices and device groups against PostgreSQL: GET/POST /api/tags,
// GET /api/tags/suggestions and the tags of GET /api/console through the real
// routes, lib/server/devices/tag-store.ts, lib/server/identity/access.ts and the audit writer. Covers the
// limits, case-insensitive names, inheritance over parent, child and
// grandchild groups, moving a device, the tag view with overrides and origin
// visibility, the expected fence, bulk changes, rights, the customer boundary,
// suggestions with their limits in one statement, audit rows with rollback,
// the cleanup triggers, the single tags statement of the console and the one
// case rule of names (tags.name_key holds tagKey, also for İ).
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {compareTagNames,tagKey,validateTag} from '../../lib/tags.ts';
import {readFileSync} from 'node:fs';
import {boundaryPhase,everyCustomer} from '../support/customer-separation.mjs';

const uuid=()=>crypto.randomUUID(),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100';
let viewer=null,checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---- Pure validation ----
check(validateTag({name:'  Env ',value:' Prod ',inherit:false},'device'),{ok:true,tag:{name:'Env',value:'Prod',inherit:false}},'name and value are trimmed');
check(validateTag({name:'x'.repeat(64),value:'v'.repeat(256),inherit:true},'group').ok,true,'64 and 256 code points are accepted');
check(validateTag({name:'😀'.repeat(64),value:'',inherit:false},'device').ok,true,'64 emoji are 64 code points');
check(validateTag({name:'x'.repeat(65),value:'',inherit:false},'device').problems,{name:'too-long'},'65 is too long');
check(validateTag({name:'   ',value:'',inherit:false},'device').problems,{name:'required'},'whitespace only is no name');
check(validateTag({name:'Env',value:'v'.repeat(257),inherit:false},'device').problems,{value:'too-long'},'257 is too long');
check(validateTag({name:'E\u0007nv',value:'a\nb',inherit:false},'device').problems,{name:'invalid',value:'invalid'},'control characters are refused');
check(validateTag({name:'Env',value:'',inherit:true},'device').problems,{inherit:'invalid'},'inherit on a device is refused');
check(validateTag({name:'Env',value:'',inherit:'yes'},'group').problems,{inherit:'invalid'},'inherit is a boolean');

const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
const HttpError=realHttpError;
const d=await sourceDatabase(),db=hookDatabase(d);
const server={db:()=>db,now:()=>Date.now(),config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>hash(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
 body:request=>request.json(),sameOrigin:()=>{},requireViewer:async()=>stamped({...viewer}),log:async()=>{},
 failure:error=>error instanceof HttpError?Response.json({error:error.message,code:error.code},{status:error.status}):Response.json({error:String(error?.message??error)},{status:500})};
const mfa={requireLiveSessions:async()=>{},requireMfa:async()=>{},isMfaEnabled:async()=>true,mfaSessionFence:async()=>sql`TRUE`,readMfaManagementProof:async()=>({guard:sql`TRUE`})};
const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../identity/mfa':mfa,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,
 '../agent/agent-protocol':{maintenanceBusy:async()=>false},'@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},
 '@/lib/management':{operations:{},safeTarget:()=>''},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},
 '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
 '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},
 '@/lib/diagnostics':{diagnosticDefinitions:{},diagnosticSecurityAccess:()=>false,isDiagnosticKind:()=>false},'@/lib/file-operations':{fileSecurityAccess:()=>false},
 '@/lib/server/devices/device-lifecycle':{removeDevice:async()=>({}),removeDevices:async()=>({}),sweepRemovedTransfers:async()=>{}},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
const load=sourceLoader();
const access=load('lib/server/identity/access.ts',imports);
const tagsApi=load('app/api/tags/route.ts',imports),suggestionsApi=load('app/api/tags/suggestions/route.ts',imports),consoleApi=load('app/api/console/route.ts',imports);
const membership=load('lib/server/devices/device-group-membership.ts',imports),{effectiveDeviceTags}=load('lib/server/devices/tag-store.ts',imports);

const time=Date.now();
const insert=(table,row)=>insertRow(d,table,row);
async function persona(name){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@tags.test',display_name:name,auth_principal:principal,auth_email:name+'@tags.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@tags.test',principal});
}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){const id=uuid();await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${id},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);return id;}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};
async function device(name,groupId,customer=customerA){const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:null,management:1,customer_id:customer});if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});return id;}

const get=async(as,scopeType,scopeId)=>{viewer=as;const response=await tagsApi.GET(new Request(`https://tags.test/api/tags?scopeType=${scopeType}&scopeId=${scopeId}`));return {status:response.status,body:await response.json()};};
const post=async(as,body)=>{viewer=as;const response=await tagsApi.POST(new Request('https://tags.test/api/tags',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
const setTag=(as,scopeType,scopeId,tag,tagId=null,expected=null)=>post(as,{action:'set-tag',scopeType,scopeId,tagId,expected,name:tag.name,value:tag.value??'',inherit:tag.inherit??false});
const removeTag=(as,scopeType,scopeId,tagId,expected)=>post(as,{action:'remove-tag',scopeType,scopeId,tagId,expected});
const bulkSet=(as,serverIds,name,value)=>post(as,{action:'bulk-set-tag',serverIds,name,value});
const bulkRemove=(as,serverIds,name)=>post(as,{action:'bulk-remove-tag',serverIds,name});
const suggestions=async as=>{viewer=as;const response=await suggestionsApi.GET(new Request('https://tags.test/api/tags/suggestions'));return {status:response.status,body:await response.json()};};
const consoleTags=async as=>{viewer=as;const response=await consoleApi.GET(new Request('https://tags.test/api/console'));assert.equal(response.status,200,'console GET');return Object.fromEntries((await response.json()).servers.map(s=>[s.id,s.tags]));};
const tagRows=()=>d.query(sql`SELECT id,scope_type,scope_id,name,value,inherit,updated_at FROM tags ORDER BY scope_type,scope_id,name_key`);
const auditRows=()=>d.query(sql`SELECT action,target,scope,server_id AS "serverId",customer_id AS "customerId" FROM audit WHERE action LIKE 'tag.%' ORDER BY id`);
const pairs=tags=>tags.map(tag=>[tag.name,tag.value]);
async function refused(promise,status,code,label){
 const [beforeRows,beforeAudit]=await Promise.all([tagRows(),auditRows()]);
 const result=await promise;
 check(result.status,status,label);if(code!==undefined)check(result.body.code,code,label+' code');
 check(await tagRows(),beforeRows,label+' leaves the tags unchanged');check((await auditRows()).length,beforeAudit.length,label+' writes no audit row');
 return result;
}

try{
 // ---- Fixture ----
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const parent=await group('Parent',null),child=await group('Child',parent),grandchild=await group('Grandchild',child),sibling=await group('Sibling',parent),groupB=await group('B group',null,customerB);
 const devG=await device('DEV-G',grandchild),devC=await device('DEV-C',child),loose=await device('LOOSE',null),full=await device('FULL',null),devB=await device('DEV-B',groupB,customerB);
 const owner=await persona('owner'),operator=await persona('operator'),reader=await persona('reader'),parentManager=await persona('parent-manager'),childViewer=await persona('child-viewer'),deviceManager=await persona('device-manager'),technician=await persona('technician');
 await grant(owner,await role('Owner',['*']),'global');
 await grant(operator,await role('Operator',access.rolePermissions.operator),'global');
 await grant(reader,await role('Reader',access.rolePermissions.viewer),'global');
 await grant(parentManager,await role('Groups on parent',['view','groups.manage']),'devicegroup',parent);
 await grant(childViewer,await role('Groups on child',['view','groups.manage']),'devicegroup',child);
 const deviceAssignment=await grant(deviceManager,await role('Groups on device',['view','groups.manage']),'device',devG);await grant(deviceManager,await role('View all',['view']),'global');
 await grant(technician,await role('Technician',['view','groups.manage']),'global');

 // Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
 await d.exec(everyCustomer(time));

 // ---- Limits ----
 let result;
 for(let index=1;index<=50;index++){result=await setTag(owner,'device',full,{name:`Tag ${String(index).padStart(2,'0')}`,value:String(index)});assert.equal(result.status,200,`tag ${index}`);}
 check(result.status,200,'the 50th tag is accepted');
 await refused(setTag(owner,'device',full,{name:'Tag 51'}),409,'TAG_LIMIT','the 51st tag');
 check((await d.one(sql`SELECT count(*)::int AS n FROM tags WHERE scope_id=${full}`)).n,50,'50 tags stored');
 result=await setTag(owner,'device',loose,{name:'n'.repeat(64),value:'v'.repeat(256)});check(result.status,200,'name of 64 and value of 256 accepted');
 await refused(setTag(owner,'device',loose,{name:'n'.repeat(65)}),400,'TAG_INVALID','name of 65');
 await refused(setTag(owner,'device',loose,{name:''}),400,'TAG_INVALID','empty name');
 await refused(setTag(owner,'device',loose,{name:'   '}),400,'TAG_INVALID','whitespace-only name');
 await refused(setTag(owner,'device',loose,{name:'Long',value:'v'.repeat(257)}),400,'TAG_INVALID','value of 257');
 await refused(setTag(owner,'device',loose,{name:'Inherit',inherit:true}),400,'TAG_INVALID','inherit on a device');
 await refused(post(owner,{action:'set-tag',scopeType:'customer',scopeId:customerA,tagId:null,expected:null,name:'X',value:'',inherit:false}),400,'TAG_INVALID','unknown scope type');
 await refused(post(owner,{action:'set-tag',scopeType:'device',scopeId:loose,tagId:null,expected:5,name:'X',value:'',inherit:false}),400,'TAG_INVALID','expected without tagId');

 // ---- Names are unique without regard to case ----
 result=await setTag(owner,'device',devG,{name:'Umgebung',value:'Prod'});check(result.status,200,'create Umgebung');
 await refused(setTag(owner,'device',devG,{name:'umgebung',value:'Test'}),409,'TAG_NAME_TAKEN','umgebung after Umgebung');
 result=await setTag(owner,'device',devG,{name:'Other',value:'x'});const other=result.body;
 await refused(setTag(owner,'device',devG,{name:'UMGEBUNG',value:'x'},other.tagId,other.updatedAt),409,'TAG_NAME_TAKEN','renaming another tag to it');
 await assert.rejects(()=>d.exec(sql`INSERT INTO tags(id,scope_type,scope_id,name,name_key,value,inherit,created_at,updated_at,updated_by) VALUES(${uuid()},'device',${devG},'UmGeBuNg','umgebung','',0,${time},${time},'sql')`),error=>error.code==='23505'&&error.constraint_name==='idx_tags_scope_name','a direct SQL insert violates the unique index');checks++;
 check((await get(reader,'device',devG)).body.direct.find(tag=>tag.name.toLowerCase()==='umgebung').name,'Umgebung','the stored name keeps its case');
 // A concurrent insert of the same name between check and commit answers TAG_NAME_TAKEN.
 db.beforeNextTransaction(()=>d.exec(sql`INSERT INTO tags(id,scope_type,scope_id,name,name_key,value,inherit,created_at,updated_at,updated_by) VALUES(${uuid()},'device',${devG},'Racing','racing','',0,${time},${time},'sql')`));
 result=await setTag(owner,'device',devG,{name:'racing'});check([result.status,result.body.code],[409,'TAG_NAME_TAKEN'],'unique violation maps to TAG_NAME_TAKEN');
 await removeTag(owner,'device',devG,other.tagId,other.updatedAt);
 await d.exec(sql`DELETE FROM tags WHERE scope_id=${devG}`);

 // ---- One case rule: tags.name_key holds tagKey, also where lower() may differ ----
 // 'İX'.toLowerCase() is i + U+0307 + x; PostgreSQL lower() depends on the
 // collation. Only the app's key decides, on both sides.
 const turkish=await device('TURKISH',null),dottedKey='İX'.toLowerCase();
 check([...dottedKey].map(c=>c.codePointAt(0)),[0x69,0x307,0x78],'the key of İX is i, U+0307, x');
 result=await setTag(owner,'device',turkish,{name:'İX',value:'dotted'});check(result.status,200,'create İX');
 check((await d.one(sql`SELECT name_key FROM tags WHERE id=${result.body.tagId}`)).name_key,dottedKey,'name_key stores tagKey(name)');
 let tagWrites=0;db.hooks.statement=text=>{if(/\b(?:INSERT INTO|UPDATE) tags\b/.test(text))tagWrites++;};
 await refused(setTag(owner,'device',turkish,{name:dottedKey,value:'combined'}),409,'TAG_NAME_TAKEN','i̇x after İX');
 db.hooks.statement=null;check(tagWrites,0,'the pre-check refuses i̇x before any write');
 await assert.rejects(()=>d.exec(sql`INSERT INTO tags(id,scope_type,scope_id,name,name_key,value,inherit,created_at,updated_at,updated_by) VALUES(${uuid()},'device',${turkish},${dottedKey},${dottedKey},'',0,${time},${time},'sql')`),error=>error.code==='23505'&&error.constraint_name==='idx_tags_scope_name','a direct SQL insert with the same name_key violates the unique index');checks++;
 result=await setTag(owner,'device',turkish,{name:'ix',value:'plain'});check(result.status,200,'ix is a separate tag, its key differs');
 check((await d.query(sql`SELECT name,name_key FROM tags WHERE scope_id=${turkish} ORDER BY name_key COLLATE "C"`)).map(row=>[row.name,row.name_key]),[['ix','ix'],['İX',dottedKey]],'both rows with their keys');
 const twoNames=list=>list.map(tag=>tag.name).sort();
 check(twoNames((await get(reader,'device',turkish)).body.direct),['ix','İX'],'the tag view lists İX and ix as two names');
 check(pairs((await effectiveDeviceTags([turkish])).get(turkish)).sort(),[['ix','plain'],['İX','dotted']],'effectiveDeviceTags keeps both');
 check(twoNames((await consoleTags(owner))[turkish]),['ix','İX'],'the console keeps both');
 check((await suggestions(owner)).body.names.filter(entry=>['ix',dottedKey].includes(tagKey(entry.name))),[{name:'ix',values:['plain']},{name:'İX',values:['dotted']}],'the suggestions list both names');
 result=await bulkSet(owner,[turkish],'İx','bulk');check(result.body,{ok:true,changed:1},'bulk-set-tag İx changes one tag');
 check(pairs((await effectiveDeviceTags([turkish])).get(turkish)).sort(),[['ix','plain'],['İx','bulk']],'it replaces the casing of İX and leaves ix');
 check((await d.one(sql`SELECT name_key FROM tags WHERE scope_id=${turkish} AND name='İx'`)).name_key,dottedKey,'the bulk update keeps the key');
 result=await bulkRemove(owner,[turkish],'ix');check(result.body,{ok:true,changed:1},'bulk-remove-tag ix removes one tag');
 check(pairs((await effectiveDeviceTags([turkish])).get(turkish)),[['İx','bulk']],'only ix is gone');
 result=await bulkSet(owner,[turkish],'ix','again');check(result.body.changed,1,'a bulk insert of ix');
 check((await d.one(sql`SELECT name_key FROM tags WHERE scope_id=${turkish} AND name='ix'`)).name_key,'ix','the bulk insert sets the key');
 await d.exec(sql`DELETE FROM tags WHERE scope_id=${turkish}`);

 // ---- Inheritance: parent → child → grandchild → device ----
 const parentEnv=(await setTag(parentManager,'group',parent,{name:'Env',value:'Prod',inherit:true})).body;
 await setTag(parentManager,'group',parent,{name:'Owner',value:'Team-P',inherit:true});
 const parentSite=(await setTag(parentManager,'group',parent,{name:'Site',value:'HQ',inherit:true})).body;
 await setTag(parentManager,'group',parent,{name:'Local',value:'parent only',inherit:false});
 result=await setTag(parentManager,'group',child,{name:'env',value:'Test',inherit:true});check(result.status,200,'right on the parent allows the child group');
 await setTag(childViewer,'group',child,{name:'Site',value:'Child-local',inherit:false});
 const deviceOwner=(await setTag(deviceManager,'device',devG,{name:'owner',value:'Device-own'})).body;check(deviceOwner.tagId!==null,true,'device right sets a device tag');
 const effective=(await effectiveDeviceTags([devG,devC,loose,uuid()]));
 check(effective.get(devG),[{name:'env',value:'Test',origin:{type:'group',id:child}},{name:'owner',value:'Device-own',origin:{type:'device'}},{name:'Site',value:'HQ',origin:{type:'group',id:parent}}],'device: own tag wins, the child overrides the parent, a non-inheritable child tag does not shadow the parent');
 check(effective.get(devC),[{name:'env',value:'Test',origin:{type:'group',id:child}},{name:'Owner',value:'Team-P',origin:{type:'group',id:parent}},{name:'Site',value:'HQ',origin:{type:'group',id:parent}}],'a device in the child group');
 check(effective.get(loose),[{name:'n'.repeat(64),value:'v'.repeat(256),origin:{type:'device'}}],'an ungrouped device has only its own tags');
 check(effective.size,4,'every input id gets a key, unknown ones too');
 let view=await get(reader,'group',grandchild);
 check(view.body.direct,[],'grandchild: no direct tags');
 check(view.body.inherited.map(tag=>[tag.name,tag.value,tag.origin.id]),[['env','Test',child],['Owner','Team-P',parent],['Site','HQ',parent]],'grandchild inherits nearest first');
 view=await get(reader,'group',child);
 check(view.body.direct.map(tag=>[tag.name,tag.value,tag.inherit,tag.overrides]),[['env','Test',true,{value:'Prod',origin:{type:'group',id:parent,name:'Parent',visible:true}}],['Site','Child-local',false,{value:'HQ',origin:{type:'group',id:parent,name:'Parent',visible:true}}]],'child: direct tags with the inherited entries they shadow');
 check(view.body.inherited.map(tag=>[tag.name,tag.value,tag.origin.name]),[['Owner','Team-P','Parent']],'child: a non-inheritable tag shadows the parent on its own view');
 view=await get(reader,'group',parent);
 check([view.body.scope,view.body.direct.length,view.body.inherited,view.body.canEdit,view.body.reason],[{type:'group',id:parent,name:'Parent'},4,[],false,'right'],'parent: four direct tags, nothing inherited, Reader cannot edit');
 check(view.body.direct.find(tag=>tag.name==='Local').inherit,false,'the non-inherited flag is kept');
 view=await get(reader,'device',devG);
 check(view.body.scope,{type:'device',id:devG,name:'DEV-G'},'device view scope');
 check(view.body.direct.map(tag=>[tag.name,tag.value,tag.inherit,tag.overrides]),[['owner','Device-own',false,{value:'Team-P',origin:{type:'group',id:parent,name:'Parent',visible:true}}]],'device: own tag overrides the parent');
 check(view.body.inherited.map(tag=>[tag.name,tag.value,tag.origin.id]),[['env','Test',child],['Site','HQ',parent]],'device: inherited entries nearest first');
 // Parity: the view's direct and inherited entries are exactly the effective tags.
 check([...view.body.direct.map(tag=>tag.name),...view.body.inherited.map(tag=>tag.name)].sort(),effective.get(devG).map(tag=>tag.name).sort(),'the device view and effectiveDeviceTags agree');
 let tagsByDevice=await consoleTags(owner);
 check(tagsByDevice[devG],[{name:'env',value:'Test',inherited:true,groupId:child},{name:'owner',value:'Device-own',inherited:false,groupId:null},{name:'Site',value:'HQ',inherited:true,groupId:parent}],'console: effective tags with inherited flag and origin group');
 check(tagsByDevice[full].length,50,'console: the full device');
 // Turning off inherit on the parent removes its tag from devices and subgroups.
 result=await setTag(parentManager,'group',parent,{name:'Site',value:'HQ',inherit:false},parentSite.tagId,parentSite.updatedAt);check(result.status,200,'turn off inherit');
 check(pairs((await effectiveDeviceTags([devG])).get(devG)),[['env','Test'],['owner','Device-own']],'the device loses the parent tag');
 check((await get(reader,'group',grandchild)).body.inherited.map(tag=>tag.name),['env','Owner'],'the grandchild group loses it');
 check((await get(reader,'group',child)).body.direct.find(tag=>tag.name==='Site').overrides,null,'the child no longer overrides it');
 const parentSiteNow=result.body;

 // ---- Moving a device changes its tags at once ----
 check((await membership.changeDeviceMemberships(owner,[devG],sibling,true,sql`TRUE`)).ok,true,'move the device to the sibling group');
 check(pairs((await consoleTags(owner))[devG]),[['Env','Prod'],['owner','Device-own']],'console: the moved device inherits from its new path');
 view=await get(reader,'device',devG);check([view.body.inherited.map(tag=>[tag.name,tag.origin.id]),view.body.direct[0].overrides.origin.id],[[['Env',parent]],parent],'view: the moved device');
 await membership.changeDeviceMemberships(owner,[devG],null,true,sql`TRUE`,true);
 check(pairs((await consoleTags(owner))[devG]),[['owner','Device-own']],'removing it from its group leaves only its own tags');
 await membership.changeDeviceMemberships(owner,[devG],grandchild,true,sql`TRUE`);

 // ---- Origin visibility ----
 view=await get(childViewer,'device',devG);
 check(view.body.direct[0].overrides.origin,{type:'group',id:parent,name:'Parent',visible:false},'an origin group without view is not visible, the name is given');
 check(view.body.inherited.find(tag=>tag.name==='env').origin.visible,true,'the child group is visible');
 check((await get(childViewer,'group',parent)).status,403,'the parent group itself answers 403 without view');

 // ---- Expected fence and inherited tag IDs ----
 await refused(setTag(parentManager,'group',parent,{name:'Site',value:'X'},parentSiteNow.tagId,parentSiteNow.updatedAt-1),409,'TAG_CHANGED','stale expected');
 await refused(setTag(owner,'device',devG,{name:'Env',value:'Hack'},parentEnv.tagId,parentEnv.updatedAt),409,'TAG_CHANGED','an inherited tag through the device');
 await refused(removeTag(owner,'group',child,parentEnv.tagId,parentEnv.updatedAt),409,'TAG_CHANGED','an inherited tag through the child group');
 await refused(removeTag(owner,'device',devG,uuid(),1),409,'TAG_CHANGED','a missing tag');
 db.beforeNextTransaction(()=>d.exec(sql`UPDATE tags SET updated_at=updated_at+5 WHERE id=${deviceOwner.tagId}`));
 result=await setTag(deviceManager,'device',devG,{name:'owner',value:'Late'},deviceOwner.tagId,deviceOwner.updatedAt);
 check([result.status,result.body.code,(await d.one(sql`SELECT value FROM tags WHERE id=${deviceOwner.tagId}`)).value],[409,'TAG_CHANGED','Device-own'],'a change between check and commit fails the fence');
 const deviceOwnerAt=deviceOwner.updatedAt+5;
 result=await setTag(deviceManager,'device',devG,{name:'Owner',value:'Renamed'},deviceOwner.tagId,deviceOwnerAt);check([result.status,result.body.updatedAt>deviceOwnerAt],[200,true],'update with the current updated_at; it moves forward');
 const renamed=result.body;
 result=await setTag(deviceManager,'device',devG,{name:'Owner',value:'Renamed'},renamed.tagId,renamed.updatedAt);check([result.status,result.body.updatedAt],[200,renamed.updatedAt],'an unchanged save writes nothing');

 // ---- Rights ----
 await refused(setTag(childViewer,'group',parent,{name:'X'}),403,undefined,'a right on the child does not allow the parent');
 await refused(setTag(childViewer,'group',sibling,{name:'X'}),403,undefined,'nor the sibling');
 await refused(setTag(deviceManager,'device',devC,{name:'X'}),403,undefined,'a device right does not allow another device');
 await refused(setTag(deviceManager,'group',grandchild,{name:'X'}),403,undefined,'a device right does not allow its group');
 await refused(setTag(operator,'device',devG,{name:'X'}),403,undefined,'Operator (no groups.manage) gets 403 on a device');
 await refused(setTag(operator,'group',parent,{name:'X'}),403,undefined,'Operator gets 403 on a group');
 await refused(setTag(owner,'device',uuid(),{name:'X'}),404,undefined,'unknown device');
 await refused(setTag(owner,'group',uuid(),{name:'X'}),404,undefined,'unknown group');
 check([(await get(deviceManager,'device',devG)).body.canEdit,(await get(deviceManager,'device',devC)).body.reason,(await get(parentManager,'group',grandchild)).body.canEdit],[true,'right',true],'canEdit per scope');
 db.beforeNextTransaction(()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${deviceAssignment}`));
 await refused(setTag(deviceManager,'device',devG,{name:'Lost'}),403,undefined,'right lost before the commit');
 await grant(deviceManager,await role('Groups on device again',['view','groups.manage']),'device',devG);

 // ---- Bulk ----
 await setTag(owner,'device',devC,{name:'patch',value:'old'});
 let before=await auditRows();
 result=await bulkSet(technician,[devG,devC,loose],'Patch','Tuesday');
 check([result.status,result.body],[200,{ok:true,changed:3}],'bulk set on three devices');
 check([(await effectiveDeviceTags([devC])).get(devC).find(tag=>tag.name.toLowerCase()==='patch')],[{name:'Patch',value:'Tuesday',origin:{type:'device'}}],'an existing tag gets the value and the given casing');
 let added=(await auditRows()).slice(before.length);
 check(added.map(row=>[row.action,row.serverId,row.scope]).sort(),[[ 'tag.set',devC,'device'],['tag.set',devG,'device'],['tag.set',loose,'device']].sort(),'one device audit row per changed device');
 check(JSON.parse(added.find(row=>row.serverId===devC).target),{scope:`device:${devC}`,old:{name:'patch',value:'old',inherit:false},new:{name:'Patch',value:'Tuesday',inherit:false}},'bulk audit target with old and new');
 before=await auditRows();
 result=await bulkSet(technician,[devG,devC],'Patch','Tuesday');check([result.status,result.body.changed,(await auditRows()).length],[200,0,before.length],'setting the same value changes nothing and writes no row');
 result=await bulkSet(technician,[devG,devC],'env','Bulk');check(result.body.changed,2,'a bulk tag with an inherited name becomes a direct tag');
 check((await get(reader,'device',devG)).body.direct.find(tag=>tag.name==='env').overrides,{value:'Test',origin:{type:'group',id:child,name:'Child',visible:true}},'and overrides the inherited one');
 result=await bulkRemove(technician,[devG,devC,loose],'ENV');check(result.body,{ok:true,changed:2},'bulk remove removes the direct tags without regard to case');
 check((await effectiveDeviceTags([devG])).get(devG).find(tag=>tag.name==='env'),{name:'env',value:'Test',origin:{type:'group',id:child}},'inherited tags stay');
 await refused(bulkSet(deviceManager,[devG,devC],'X','1'),403,undefined,'one device without the right: nothing changes');
 await refused(bulkRemove(deviceManager,[devG,devC],'Patch'),403,undefined,'bulk remove without the right on one device');
 await refused(bulkSet(technician,[devG,full],'New','1'),409,'TAG_LIMIT','one device at 50 tags: nothing changes');
 result=await bulkSet(technician,[devG,full],'Tag 01','replaced');check(result.body.changed,2,'replacing an existing tag on a full device is allowed');
 await refused(bulkSet(technician,Array.from({length:1001},()=>uuid()),'X','1'),400,'TAG_INVALID','more than 1000 ids');
 await refused(bulkSet(technician,[],'X','1'),400,'TAG_INVALID','no ids');
 await refused(bulkSet(technician,[devG,uuid()],'X','1'),404,undefined,'an unknown device in the set');
 await refused(bulkSet(technician,[devG],' ','1'),400,'TAG_INVALID','an invalid name');
 // A failing audit insert rolls the whole bulk change back.
 await createTrigger(d,'bulk_audit_fails','audit','BEFORE INSERT',{message:'audit-down',when:`NEW.action='tag.set' AND NEW.server_id='${devC}'`});
 const beforeBulkFailure=await tagRows();
 result=await bulkSet(technician,[devG,devC],'Rollback','1');check(result.status,500,'an audit failure fails the bulk request');
 check(await tagRows(),beforeBulkFailure,'and rolls every device back');
 await dropTrigger(d,'bulk_audit_fails');

 // ---- Audit of single changes ----
 before=await auditRows();
 const groupTag=(await setTag(parentManager,'group',grandchild,{name:'Audit',value:'1',inherit:true})).body;
 await setTag(parentManager,'group',grandchild,{name:'Audit',value:'2',inherit:false},groupTag.tagId,groupTag.updatedAt);
 const latest=(await get(reader,'group',grandchild)).body.direct.find(tag=>tag.name==='Audit');
 await removeTag(parentManager,'group',grandchild,latest.id,latest.updatedAt);
 added=(await auditRows()).slice(before.length);
 check(added.map(row=>[row.action,row.scope,row.serverId,row.customerId]),[['tag.set','portal',null,customerA],['tag.set','portal',null,customerA],['tag.remove','portal',null,customerA]],'group tags write portal rows with the group customer');
 check(added.map(row=>JSON.parse(row.target)),[
  {scope:`group:${grandchild}`,old:null,new:{name:'Audit',value:'1',inherit:true}},
  {scope:`group:${grandchild}`,old:{name:'Audit',value:'1',inherit:true},new:{name:'Audit',value:'2',inherit:false}},
  {scope:`group:${grandchild}`,old:{name:'Audit',value:'2',inherit:false},new:null}],'targets with old and new');
 before=await auditRows();
 const deviceTag=(await setTag(owner,'device',devC,{name:'Single'})).body;
 added=(await auditRows()).slice(before.length);
 check([added.length,added[0].scope,added[0].serverId,JSON.parse(added[0].target)],[1,'device',devC,{scope:`device:${devC}`,old:null,new:{name:'Single',value:'',inherit:false}}],'device tags write a device row');
 await createTrigger(d,'tag_audit_fails','audit','BEFORE INSERT',{message:'audit-down',when:"NEW.action LIKE 'tag.%'"});
 const beforeFailure=await tagRows();
 check((await setTag(owner,'device',devC,{name:'Never'})).status,500,'audit failure fails a create');
 check((await removeTag(owner,'device',devC,deviceTag.tagId,deviceTag.updatedAt)).status,500,'audit failure fails a remove');
 check(await tagRows(),beforeFailure,'audit failure rolls the change back');
 await dropTrigger(d,'tag_audit_fails');

 // ---- One tags statement in the console, whatever the number of devices ----
 let statements=0;db.hooks.statement=text=>{if(/\b(?:FROM|JOIN) tags\b/.test(text))statements++;};
 tagsByDevice=await consoleTags(owner);db.hooks.statement=null;
 check(statements,1,'the console reads the tags of all visible devices in one statement');
 check(Object.keys(tagsByDevice).length>=5,true,'for several devices');

 // ---- Customer boundary and suggestions ----
 await setTag(owner,'device',devB,{name:'Secret',value:'B only'});
 await setTag(owner,'group',groupB,{name:'BGroup',value:'B group only',inherit:true});
 let names=(await suggestions(childViewer)).body.names;
 check(names.some(entry=>entry.name==='Local'),false,'suggestions leave out the tags of a group without view');
 check(names.some(entry=>entry.name==='Tag 02'),false,'and of devices without view');
 check(names.find(entry=>entry.name==='env')?.values,['Test'],'but give the tags of visible groups');
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${technician.id},${time},'fixture')`);
 check((await get(technician,'device',devB)).status,404,'a device of another customer answers 404');
 check((await get(technician,'group',groupB)).status,404,'a group of another customer answers 404');
 await refused(setTag(technician,'device',devB,{name:'X'}),404,undefined,'set on another customer device');
 await refused(setTag(technician,'group',groupB,{name:'X'}),404,undefined,'set on another customer group');
 await refused(bulkSet(technician,[devG,devB],'X','1'),404,undefined,'bulk with a device of another customer');
 names=(await suggestions(technician)).body.names;
 check(names.some(entry=>['secret','bgroup'].includes(entry.name.toLowerCase())),false,'suggestions leave out another customer');
 check(names.find(entry=>entry.name.toLowerCase()==='patch'),{name:'Patch',values:['Tuesday']},'suggestions give names with values');
 check(names.find(entry=>entry.name==='Single'),{name:'Single',values:[]},'empty values are left out');
 check(names.map(entry=>entry.name.toLowerCase()),[...new Set(names.map(entry=>entry.name.toLowerCase()))].sort((a,b)=>a<b?-1:a>b?1:0),'names are de-duplicated and sorted');
 names=(await suggestions(owner)).body.names;
 check(names.some(entry=>entry.name==='Secret'),true,'the Owner sees every customer');

 // ---- Suggestion limits in SQL: 500 names, 100 values per name ----
 // 600 names on 12 devices (50 each) and one name with 120 values on 120
 // devices, in two casings; direct SQL inserts, the API stops at 50 per object.
 const capDevices=(await d.query(sql`INSERT INTO servers(id,name,token_hash,created_at,management,customer_id) SELECT gen_random_uuid()::text,'CAP-'||n,'fixture-cap-'||n,${time},1,${customerA} FROM generate_series(1,120) n RETURNING id`)).map(row=>String(row.id));
 const pad=n=>String(n).padStart(3,'0'),capRows=[
  ...Array.from({length:600},(_,n)=>({scope_id:capDevices[Math.floor(n/50)],name:`Cap ${pad(n)}`,value:n%2?`c${pad(n)}`:''})),
  ...capDevices.map((id,n)=>({scope_id:id,name:n%2?'Batch':'BATCH',value:`v${pad(119-n)}`}))];
 await d.exec(sql`INSERT INTO tags(id,scope_type,scope_id,name,name_key,value,inherit,created_at,updated_at,updated_by) SELECT gen_random_uuid()::text,'device',r.scope_id,r.name,r.name_key,r.value,0,${time},${time},'sql' FROM jsonb_to_recordset(${JSON.stringify(capRows.map(row=>({...row,name_key:tagKey(row.name)})))}::jsonb) AS r(scope_id text,name text,name_key text,value text)`);
 const allKeys=[...new Set((await d.query(sql`SELECT name_key FROM tags`)).map(row=>row.name_key))].sort((a,b)=>a<b?-1:a>b?1:0);
 check(allKeys.length>600,true,'more than 600 distinct name keys are stored');
 const tagStatements=[];db.hooks.after=(text,inTransaction,rows)=>{if(/\b(?:FROM|JOIN) tags\b/.test(text))tagStatements.push(Array.isArray(rows)?rows.length:-1);};
 names=(await suggestions(owner)).body.names;db.hooks.after=null;
 check(tagStatements.length,1,'the suggestions read the tags in one statement');
 check(tagStatements[0]<=500,true,'that statement returns at most 500 rows');
 check(names.length,500,'exactly 500 names');
 check(names.map(entry=>tagKey(entry.name)).sort(),allKeys.slice(0,500),'the first 500 keys in code-point order');
 check(names,[...names].sort(compareTagNames),'sorted by compareTagNames');
 const batch=names.find(entry=>tagKey(entry.name)==='batch');
 check(batch?.name,'BATCH','a key shows its smallest stored name in code-point order');
 check(batch.values,Array.from({length:100},(_,n)=>`v${pad(n)}`),'100 values: the first distinct ones in code-point order');
 check(names.find(entry=>entry.name==='Cap 000')?.values,[],'empty values are left out');
 check(names.find(entry=>entry.name==='Cap 001')?.values,['c001'],'a name with one value');
 check(names.every(entry=>entry.values.length<=100&&entry.values.every(value=>value!=='')),true,'no name has more than 100 values or an empty value');
 await d.exec(sql`DELETE FROM tags WHERE scope_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(capDevices)}::jsonb))`);

 // ---- Source: no case function of the database, every insert names name_key ----
 const store=readFileSync(new URL('../../lib/server/devices/tag-store.ts',import.meta.url),'utf8');
 check(/\blower\s*\(/i.test(store),false,'lib/server/devices/tag-store.ts contains no lower(');
 const inserts=[...store.matchAll(/INSERT INTO tags\(([^)]*)\)/g)].map(match=>match[1].split(','));
 check([inserts.length,inserts.every(columns=>columns.includes('name_key'))],[2,true],'both INSERT INTO tags name name_key');

 // ---- Cleanup triggers ----
 const empty=await group('Empty',null);await setTag(owner,'group',empty,{name:'Doomed',inherit:true});
 check((await d.query(sql`SELECT 1 FROM tags WHERE scope_id=${empty}`)).length,1,'group tag exists');
 await d.exec(sql`DELETE FROM device_groups WHERE id=${empty}`);
 check((await d.query(sql`SELECT 1 FROM tags WHERE scope_id=${empty}`)).length,0,'deleting the group deletes its tags');
 check((await d.query(sql`SELECT 1 FROM tags WHERE scope_id=${devC}`)).length>0,true,'device tags exist');
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${devC}`);
 check((await d.query(sql`SELECT 1 FROM tags WHERE scope_id=${devC}`)).length,0,'removing the device deletes its tags');
 check((await effectiveDeviceTags([devC])).get(devC),[],'a removed device has no effective tags');
 console.log(`PASS tags (${checks} checks): validation, limits, case-insensitive names, inheritance over parent, child, grandchild and device, moving, view with overrides and origin visibility, expected fence, rights, bulk, audit with rollback, customer boundary, suggestions with 500 names and 100 values in one statement, one case rule through name_key (İX and ix), cleanup triggers and one console tags query.`);
}finally{await d.close();}
