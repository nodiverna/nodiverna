// Server side of the tags (lib/tags.ts): the effective resolution, the tag view
// of GET /api/tags, the suggestions of GET /api/tags/suggestions and the
// changes of POST /api/tags. app/api/tags/route.ts and
// app/api/tags/suggestions/route.ts are thin adapters; the console route reads
// the effective tags of every visible device through effectiveDeviceTags in one
// statement.
//
// effectiveDeviceTags is the entry point for later tag targets (alert rules,
// notifications, runbooks): it resolves inheritance at read time, so moving a
// device or removing it from its group changes its tags at once, with no
// stored copy.
//
// Names are compared through tagKey (lib/tags.ts), the one case rule: every
// write sets tags.name_key from it in the same statement, and every statement
// here compares, groups and orders by name_key, never by a case function of
// the database.
import {guid,HttpError,now} from '../context';
import {allowedGroupIds,customerAccessGuard,devicePermissionGuard,effectivePermissions,groupPermissionGuard,groupPermissions,permissionsFor,principal,requireDevice,requireGroup,type SqlGuard} from '../identity/access';
import {auditAfterChange,auditEvent} from '../audit';
import {featureWriteGuard} from '../identity/feature-authorization';
import {commitSessionChange} from '../identity/rbac';
import {mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import {isUniqueViolation} from '../errors/db-codes';
import {compareTagNames,isTagScopeType,tagBulkMax,tagKey,tagLimit,validateTag,type DirectTag,type EffectiveDeviceTag,type InheritedTag,type TagEditReason,type TagInput,type TagOriginView,type TagScopeType,type TagSuggestions,type TagView} from '../../tags';
import type {Viewer} from '../../types';
import {db,runSteps,sql,type Sql} from '../db';

// The right that organizes devices and groups today: Manage device groups and permissions.
const right='groups.manage';
const invalid=()=>new HttpError('apiError.tags.invalid');
const changed=()=>new HttpError('apiError.tags.changed');
const nameTaken=()=>new HttpError('apiError.tags.nameTaken');
const limitReached=()=>new HttpError('apiError.tags.limit');
const ids=(list:string[])=>sql`(SELECT value FROM jsonb_array_elements_text(${JSON.stringify(list)}::jsonb))`;

type EffectiveRow={device_id:string;name:string;value:string;origin_id:string|null};
/**
 * The effective tags of each device: its own tags plus the inheritable tags of
 * its group and of every ancestor of that group; per name key the nearest entry
 * wins. One statement for any number of devices. Every input ID gets a key;
 * unknown and removed devices get no tags. Each list is sorted by
 * compareTagNames.
 */
export async function effectiveDeviceTags(deviceIds:string[]):Promise<Map<string,EffectiveDeviceTag[]>>{
 const list=[...new Set(deviceIds)],result=new Map<string,EffectiveDeviceTag[]>(list.map(id=>[id,[]]));
 if(!list.length)return result;
 const rows=await db().query<EffectiveRow>(sql`WITH tag_target AS (SELECT id FROM servers WHERE revoked=0 AND id IN ${ids(list)}),
 tag_candidate AS (
  SELECT tag_target.id AS device_id,t.name,t.name_key,t.value,NULL::text AS origin_id,-1::bigint AS distance FROM tag_target JOIN tags t ON t.scope_type='device' AND t.scope_id=tag_target.id
  UNION ALL SELECT tag_target.id,t.name,t.name_key,t.value,t.scope_id,a.depth FROM tag_target JOIN device_group_members m ON m.server_id=tag_target.id JOIN device_group_ancestors a ON a.group_id=m.group_id JOIN tags t ON t.scope_type='group' AND t.scope_id=a.ancestor_id AND t.inherit=1)
 SELECT DISTINCT ON (device_id,name_key) device_id,name,value,origin_id FROM tag_candidate ORDER BY device_id,name_key,distance,name`);
 for(const row of rows)result.get(String(row.device_id))?.push({name:row.name,value:row.value,origin:row.origin_id===null?{type:'device'}:{type:'group',id:String(row.origin_id)}});
 for(const tags of result.values())tags.sort(compareTagNames);
 return result;
}
/** The effective tags of the visible devices (`scope`, the JSON array of their IDs) for GET /api/console. */
export async function consoleDeviceTags(scope:string){
 const parsed:unknown=JSON.parse(scope),list=Array.isArray(parsed)?parsed.filter((id):id is string=>typeof id==='string'):[];
 const tags=await effectiveDeviceTags(list);
 return new Map([...tags].map(([id,entries])=>[id,entries.map(tag=>({name:tag.name,value:tag.value,inherited:tag.origin.type==='group',groupId:tag.origin.type==='group'?tag.origin.id:null}))]));
}

type Scope={type:TagScopeType;id:string};
type TagRow={id:string;name:string;value:string;inherit:number;updated_at:number};
type ChainRow={name:string;value:string;origin_id:string;origin_name:string;distance:number};
const tagOf=(row:TagRow)=>({id:String(row.id),name:row.name,value:row.value,inherit:Number(row.inherit)===1,updatedAt:Number(row.updated_at)});

function parseScope(type:unknown,id:unknown):Scope{
 if(!isTagScopeType(type)||!guid(id))throw invalid();
 return {type,id:id.toLowerCase()};
}
async function directTags(scope:Scope){
 return (await db().query<TagRow>(sql`SELECT id,name,value,inherit,updated_at FROM tags WHERE scope_type=${scope.type} AND scope_id=${scope.id} ORDER BY name_key,name`)).map(tagOf);
}
/**
 * The inheritable tags that reach the scope from above, nearest first: for a
 * device those of its group and its ancestors, for a group those of its strict
 * ancestors.
 */
async function inheritedChain(scope:Scope):Promise<ChainRow[]>{
 const path=scope.type==='group'
  ?sql`SELECT a.ancestor_id,a.depth FROM device_group_ancestors a WHERE a.group_id=${scope.id} AND a.depth>0`
  :sql`SELECT a.ancestor_id,a.depth FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id=${scope.id}`;
 return db().query<ChainRow>(sql`SELECT t.name,t.value,t.scope_id AS origin_id,g.name AS origin_name,p.depth AS distance FROM (${path}) p JOIN tags t ON t.scope_type='group' AND t.scope_id=p.ancestor_id AND t.inherit=1 JOIN device_groups g ON g.id=t.scope_id ORDER BY p.depth,t.name_key,t.name`);
}
/** The nearest entry per name of a chain that is sorted nearest first. */
function nearest(chain:ChainRow[]):Map<string,ChainRow>{
 const winners=new Map<string,ChainRow>();
 for(const row of chain)if(!winners.has(tagKey(row.name)))winners.set(tagKey(row.name),row);
 return winners;
}
async function scopeName(scope:Scope):Promise<{name:string;customerId:string|null}>{
 const row=await db().one<{name:string;customer_id:string|null}>(scope.type==='group'?sql`SELECT name,customer_id FROM device_groups WHERE id=${scope.id}`:sql`SELECT name,customer_id FROM servers WHERE id=${scope.id}`);
 return {name:row?.name??'',customerId:row?.customer_id??null};
}
/** The guard of a change on this scope: the right on the device or on the group (ancestors included) and the customer boundary. */
function scopeGuard(v:Viewer,scope:Scope):SqlGuard{
 const me=sql`${principal(v)}`;
 return scope.type==='group'?groupPermissionGuard(sql`${scope.id}`,me,right):devicePermissionGuard(sql`${scope.id}`,me,right);
}
/** 404 outside the boundary or unknown, 403 without the permission. */
async function requireScope(v:Viewer,scope:Scope,permission:'view'|typeof right){
 if(scope.type==='group')await requireGroup(v,scope.id,permission);
 else await requireDevice(v,scope.id,permission);
}
async function editState(v:Viewer,scope:Scope):Promise<{canEdit:boolean;reason:TagEditReason|null}>{
 const rights=scope.type==='group'?await groupPermissions(v,scope.id):await permissionsFor(v,scope.id);
 return rights.includes(right)?{canEdit:true,reason:null}:{canEdit:false,reason:'right'};
}

/** GET /api/tags?scopeType=device|group&scopeId=<id>. */
export async function tagView(v:Viewer,params:URLSearchParams):Promise<TagView>{
 const scope=parseScope(params.get('scopeType'),params.get('scopeId'));
 await requireScope(v,scope,'view');
 const [own,chain,edit,visibleGroups,named,effective]=await Promise.all([directTags(scope),inheritedChain(scope),editState(v,scope),allowedGroupIds(v,'view'),scopeName(scope),scope.type==='device'?effectiveDeviceTags([scope.id]):Promise.resolve(null)]);
 const visible=new Set(visibleGroups),names=new Map(chain.map(row=>[String(row.origin_id),row.origin_name]));
 const origin=(id:string):TagOriginView=>({type:'group',id,name:names.get(id)??'',visible:visible.has(id)});
 const winners=nearest(chain),ownNames=new Set(own.map(tag=>tagKey(tag.name)));
 const direct:DirectTag[]=own.map(tag=>{const shadowed=winners.get(tagKey(tag.name));return {...tag,overrides:shadowed?{value:shadowed.value,origin:origin(String(shadowed.origin_id))}:null};});
 // A device's inherited entries are its effective tags of group origin (the
 // resolution of the console); a group's are the winners its own tags leave.
 const inheritedEntries=effective
  ?(effective.get(scope.id)??[]).flatMap(tag=>tag.origin.type==='group'?[{name:tag.name,value:tag.value,originId:tag.origin.id}]:[])
  :[...winners.values()].filter(row=>!ownNames.has(tagKey(row.name))).map(row=>({name:row.name,value:row.value,originId:String(row.origin_id)}));
 const distance=new Map(chain.map(row=>[String(row.origin_id),Number(row.distance)]));
 const inherited:InheritedTag[]=inheritedEntries.map(entry=>({name:entry.name,value:entry.value,origin:origin(entry.originId)}))
  .sort((a,b)=>(distance.get(a.origin.id)??0)-(distance.get(b.origin.id)??0)||compareTagNames(a,b));
 return {scope:{type:scope.type,id:scope.id,name:named.name},direct,inherited,...edit};
}

/** The most names of the suggestions, and the most values per name. */
const suggestedNames=500,suggestedValues=100;
type SuggestionRow={name:string;value_list:string|string[]};
/**
 * GET /api/tags/suggestions: names with their values, only from tags of
 * devices and groups the viewer may view, so they stay inside the customer
 * boundary. One statement applies the limits: one row per name key, the first
 * 500 keys in code-point order, each with its smallest stored name and the
 * first 100 distinct non-empty values in code-point order. The answer is
 * sorted by compareTagNames, the values of a name too.
 */
export async function tagSuggestions(v:Viewer):Promise<TagSuggestions>{
 const me=sql`${principal(v)}`;
 const rows=await db().query<SuggestionRow>(sql`WITH visible AS (
  SELECT t.name_key,t.name,t.value FROM tags t WHERE (t.scope_type='device' AND EXISTS (SELECT 1 FROM servers s WHERE s.id=t.scope_id AND ${devicePermissionGuard(sql`s.id`,me,'view')}))
   OR (t.scope_type='group' AND ${groupPermissionGuard(sql`t.scope_id`,me,'view')})),
 suggested AS (SELECT name_key,min(name COLLATE "C") AS name FROM visible GROUP BY name_key ORDER BY name_key COLLATE "C" LIMIT ${suggestedNames}),
 ranked AS (SELECT name_key,value,row_number() OVER (PARTITION BY name_key ORDER BY value COLLATE "C") AS rank FROM (SELECT DISTINCT visible.name_key,visible.value FROM visible JOIN suggested ON suggested.name_key=visible.name_key WHERE visible.value<>'') distinct_value)
 SELECT suggested.name,coalesce((SELECT jsonb_agg(ranked.value ORDER BY ranked.value COLLATE "C") FROM ranked WHERE ranked.name_key=suggested.name_key AND ranked.rank<=${suggestedValues}),'[]'::jsonb)::text AS value_list FROM suggested`);
 const sortText=(a:string,b:string)=>compareTagNames({name:a},{name:b});
 return {names:rows.map(row=>({name:row.name,values:(typeof row.value_list==='string'?JSON.parse(row.value_list) as string[]:row.value_list).sort(sortText)})).sort(compareTagNames)};
}

const auditTag=(tag:TagInput|null)=>tag&&{name:tag.name,value:tag.value,inherit:tag.inherit};
const scopeText=(scope:Scope)=>`${scope.type}:${scope.id}`;
function parseExpected(value:unknown):number|null|undefined{return value===null?null:typeof value==='number'&&Number.isSafeInteger(value)?value:undefined;}
/** Runs a change and turns a unique violation of the name index into TAG_NAME_TAKEN. */
async function uniqueNames<T>(change:()=>Promise<T>):Promise<T>{
 try{return await change();}catch(e){if(isUniqueViolation(e,'idx_tags_scope_name'))throw nameTaken();throw e;}
}

/**
 * POST /api/tags set-tag and remove-tag on one device or group. set-tag
 * creates a tag (tagId and expected null) or updates name, value and inherit of
 * one; remove-tag deletes one. `expected` is the updated_at the client showed;
 * the committing statement holds only while it still matches and the tag
 * belongs to the scope, so an inherited tag never changes through the
 * inheriting object. Routine change: no step-up proof, the statement carries
 * the right, the write guard, the live session fence and (on create) the limit
 * of 50 tags. The audit row commits with the change.
 */
async function changeTag(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;tagId:string|null;updatedAt:number|null}>{
 const scope=parseScope(p.scopeType,p.scopeId),expected=parseExpected(p.expected);
 const tagId=p.tagId===null||p.tagId===undefined?null:guid(p.tagId)?p.tagId.toLowerCase():undefined;
 if(expected===undefined||tagId===undefined||(tagId===null)!==(expected===null))throw invalid();
 let tag:TagInput|null=null;
 if(p.action==='set-tag'){
  const result=validateTag({name:p.name,value:p.value,inherit:p.inherit},scope.type);
  if(!result.ok)throw invalid();
  tag=result.tag;
 }else if(tagId===null)throw invalid();
 await requireScope(v,scope,right);
 const own=await directTags(scope),current=tagId===null?null:own.find(row=>row.id===tagId)??null;
 if(tagId!==null&&(!current||current.updatedAt!==expected))throw changed();
 if(tag&&own.some(row=>row.id!==tagId&&tagKey(row.name)===tagKey(tag.name)))throw nameTaken();
 if(tag&&!current&&own.length>=tagLimit)throw limitReached();
 if(tag&&current&&current.name===tag.name&&current.value===tag.value&&current.inherit===tag.inherit)return {ok:true,tagId:current.id,updatedAt:current.updatedAt};
 const fence=await mfaSessionFence(request,v),guard=sql`(${featureWriteGuard(v,scopeGuard(v,scope))}) AND (${fence})`,time=now();
 const inScope=sql`scope_type=${scope.type} AND scope_id=${scope.id}`,id=current?.id??crypto.randomUUID();
 let statement:Sql;
 if(tag&&!current)statement=sql`INSERT INTO tags(id,scope_type,scope_id,name,name_key,value,inherit,created_at,updated_at,updated_by) SELECT ${id},${scope.type},${scope.id},${tag.name},${tagKey(tag.name)},${tag.value},${tag.inherit?1:0},${time},${time},${v.label} WHERE (SELECT count(*) FROM tags WHERE ${inScope})<${tagLimit} AND ${guard} RETURNING id,updated_at`;
 else if(tag)statement=sql`UPDATE tags SET name=${tag.name},name_key=${tagKey(tag.name)},value=${tag.value},inherit=${tag.inherit?1:0},updated_at=GREATEST(${time}::bigint,updated_at+1),updated_by=${v.label} WHERE id=${id} AND ${inScope} AND updated_at=${expected} AND ${guard} RETURNING id,updated_at`;
 else statement=sql`DELETE FROM tags WHERE id=${id} AND ${inScope} AND updated_at=${expected} AND ${guard} RETURNING id,updated_at`;
 const named=scope.type==='group'?await scopeName(scope):null;
 const audit=auditEvent({actor:v.label,action:tag?'tag.set':'tag.remove',target:JSON.stringify({scope:scopeText(scope),old:auditTag(current),new:auditTag(tag)}),guard:auditAfterChange,at:time,
  ...(scope.type==='device'?{serverIds:[scope.id]}:{customerId:named?.customerId??null})});
 const row=await uniqueNames(()=>commitSessionChange(statement,audit));
 if(!row){
  // Refused in the transaction: a lost right or scope answers like the
  // pre-check, an ended session with its own 401, a full object with
  // TAG_LIMIT; otherwise the tags changed meanwhile.
  await requireScope(v,scope,right);await requireLiveSessions(request,v);
  if(tag&&!current&&(await directTags(scope)).length>=tagLimit)throw limitReached();
  throw changed();
 }
 return {ok:true,tagId:tag?String(row.id):null,updatedAt:tag?Number(row.updated_at):null};
}

function parseServerIds(value:unknown):string[]{
 if(!Array.isArray(value)||value.length<1||value.length>tagBulkMax||!value.every(id=>guid(id)))throw invalid();
 return [...new Set((value as string[]).map(id=>id.toLowerCase()))];
}
/** 404 when a device is unknown, removed or outside the boundary, 403 when the right is missing on one. */
async function requireDevices(v:Viewer,serverIds:string[]){
 const found=await db().query<{id:string}>(sql`SELECT id FROM servers WHERE id IN ${ids(serverIds)} AND revoked=0 AND ${customerAccessGuard(sql`servers.customer_id`,sql`${principal(v)}`)}`);
 if(found.length!==serverIds.length)throw new HttpError('apiError.device.notFound');
 const rights=await effectivePermissions(v,serverIds);
 if(serverIds.some(id=>!rights.get(id)?.includes(right)))throw new HttpError('apiError.tags.devicePermissionMissing',{permission:right});
}
type BulkRow={scope_id:string;old_name:string|null;old_value:string|null;name:string;value:string};

/**
 * POST /api/tags bulk-set-tag {serverIds, name, value} and bulk-remove-tag
 * {serverIds, name}: one tag on 1-1000 devices, all or nothing in one
 * transaction. bulk-set-tag sets the tag on every device and replaces the
 * value (and the casing of the name) of a tag with the same name;
 * bulk-remove-tag removes the direct tag with that name. The transaction first
 * checks the right on every device, the write guard and the live session
 * fence, then (on set) the limit of 50 tags on every device that gets a new
 * tag; a refusal changes nothing. One device audit row per changed device.
 */
async function changeTagsInBulk(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;changed:number}>{
 const serverIds=parseServerIds(p.serverIds),set=p.action==='bulk-set-tag';
 const result=validateTag({name:p.name,value:set?p.value:'',inherit:false},'device');
 if(!result.ok)throw invalid();
 const tag=result.tag,key=tagKey(tag.name);
 await requireDevices(v,serverIds);
 const fence=await mfaSessionFence(request,v),time=now(),me=sql`${principal(v)}`,target=ids(serverIds);
 const rights=sql`(SELECT count(*) FROM servers rights_device WHERE rights_device.id IN ${target} AND ${devicePermissionGuard(sql`rights_device.id`,me,right)})=${serverIds.length}`;
 const admission=sql`(${featureWriteGuard(v,rights)}) AND (${fence})`;
 const sameName=(device:Sql)=>sql`EXISTS (SELECT 1 FROM tags same_name WHERE same_name.scope_type='device' AND same_name.scope_id=${device} AND same_name.name_key=${key})`;
 const outcome=await uniqueNames(()=>db().transaction(async tx=>{
  if(!await tx.one(sql`SELECT 1 AS admitted WHERE ${admission}`))return 'refused' as const;
  let rows:BulkRow[];
  if(set){
   if(await tx.one(sql`SELECT 1 AS full FROM servers s WHERE s.id IN ${target} AND NOT ${sameName(sql`s.id`)} AND (SELECT count(*) FROM tags WHERE scope_type='device' AND scope_id=s.id)>=${tagLimit} LIMIT 1`))return 'limit' as const;
   const updated=await tx.query<BulkRow>(sql`UPDATE tags t SET name=${tag.name},name_key=${key},value=${tag.value},updated_at=GREATEST(${time}::bigint,t.updated_at+1),updated_by=${v.label} FROM tags old WHERE old.id=t.id AND t.scope_type='device' AND t.scope_id IN ${target} AND t.name_key=${key} AND (t.name<>${tag.name} OR t.value<>${tag.value}) RETURNING t.scope_id,old.name AS old_name,old.value AS old_value,t.name,t.value`);
   const inserted=await tx.query<BulkRow>(sql`INSERT INTO tags(id,scope_type,scope_id,name,name_key,value,inherit,created_at,updated_at,updated_by) SELECT gen_random_uuid()::text,'device',s.id,${tag.name},${key},${tag.value},0,${time},${time},${v.label} FROM servers s WHERE s.id IN ${target} AND NOT ${sameName(sql`s.id`)} RETURNING scope_id,NULL::text AS old_name,NULL::text AS old_value,name,value`);
   rows=[...updated,...inserted];
  }else rows=await tx.query<BulkRow>(sql`DELETE FROM tags WHERE scope_type='device' AND scope_id IN ${target} AND name_key=${key} RETURNING scope_id,name AS old_name,value AS old_value,name,value`);
  // The rows above are exactly the changed devices of this transaction.
  await runSteps(tx,rows.flatMap(row=>auditEvent({actor:v.label,action:set?'tag.set':'tag.remove',guard:sql`TRUE`,at:time,serverIds:[String(row.scope_id)],
   target:JSON.stringify({scope:`device:${String(row.scope_id)}`,old:row.old_name===null?null:{name:row.old_name,value:row.old_value,inherit:false},new:set?{name:row.name,value:row.value,inherit:false}:null})})));
  return rows.length;
 }));
 if(outcome==='limit')throw new HttpError('apiError.tags.limit');
 if(outcome==='refused'){await requireDevices(v,serverIds);await requireLiveSessions(request,v);throw changed();}
 return {ok:true,changed:outcome};
}

/** POST /api/tags: set-tag, remove-tag, bulk-set-tag, bulk-remove-tag. */
export async function changeTags(request:Request,v:Viewer,p:Record<string,unknown>){
 if(p.action==='set-tag'||p.action==='remove-tag')return changeTag(request,v,p);
 if(p.action==='bulk-set-tag'||p.action==='bulk-remove-tag')return changeTagsInBulk(request,v,p);
 throw new HttpError('apiError.request.unknownAction');
}
