// Server side of the ESU dates (Extended Security Updates) per customer, group or device:
// GET and POST /api/os-support/esu and the rows the console reads for every
// visible device in one statement. Microsoft does not report ESU, so a
// technician enters the date; the support end of the operating system moves to
// it when it is later (lib/os-support.ts). Changing it needs alerts.manage
// because it changes what the rule os-support-end reports. Same pattern as
// lib/server/devices/alert-rule-overrides.ts: boundary, expected fence, routine session change
// and one audit row in the same transaction. A customer date needs the global
// alerts.manage and sight of the customer, as alert rules on a customer.
import {guid,HttpError,now} from '../context';
import {allowedGroupIds,customerAccessGuard,devicePermissionGuard,globalPermissionGuard,groupPermissionGuard,groupPermissions,hasGlobalPermission,permissionsFor,principal,requireDevice,requireGroup,type SqlGuard} from '../identity/access';
import {customerSeen} from './alert-rule-overrides';
import {auditAfterChange,auditEvent} from '../audit';
import {featureWriteGuard} from '../identity/feature-authorization';
import {commitSessionChange} from '../identity/rbac';
import {mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import type {Viewer} from '../../types';
import {db,sql,type Queryable} from '../db';
import type {AlertEditReason} from '../../alert-rules';
import type {EsuOverride,EsuScopeType} from '../../os-support';

export type EsuScope={type:EsuScopeType;id:string};
export type EsuOriginView={type:'customer'|'group';id:string;name:string;visible:boolean};
/** The answer of GET /api/os-support/esu. */
export type EsuView={override:{until:string;updatedAt:number}|null;inherited:{until:string;origin:EsuOriginView}|null;effective:string|null;canEdit:boolean;reason:AlertEditReason|null};

type EsuRow={scope_type:string;scope_id:string;until:string;updated_at:number};
const columns=sql`scope_type,scope_id,until,updated_at`;
function rowsOf(rows:EsuRow[]):EsuOverride[]{
 return rows.flatMap(row=>row.scope_type==='customer'||row.scope_type==='group'||row.scope_type==='device'?[{scopeType:row.scope_type,scopeId:String(row.scope_id),until:String(row.until),updatedAt:Number(row.updated_at)}]:[]);
}
/** The ESU rows that can apply to the visible devices (`scope`, the JSON array of their IDs): their own, those of every group on their paths and those of their customers. One statement. `q`: the transaction handle of the alarm state (lib/server/devices/alerts.ts). */
export async function consoleEsuOverrides(scope:string,q:Queryable=db()):Promise<EsuOverride[]>{
 return rowsOf(await q.query<EsuRow>(sql`SELECT ${columns} FROM os_esu_overrides WHERE (scope_type='device' AND scope_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)))
  OR (scope_type='customer' AND scope_id IN (SELECT s.customer_id FROM servers s WHERE s.id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))))
  OR (scope_type='group' AND scope_id IN (SELECT a.ancestor_id FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))))`));
}

const invalid=()=>new HttpError('apiError.esu.invalid');
const changed=()=>new HttpError('apiError.esu.changed');
function parseScope(type:unknown,id:unknown):EsuScope{
 if((type!=='customer'&&type!=='group'&&type!=='device')||!guid(id))throw invalid();
 return {type,id:id.toLowerCase()};
}
/** A real calendar date YYYY-MM-DD from 2000-01-01 to 2040-12-31, else null. */
export function validEsuDate(value:unknown):string|null{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
 const date=new Date(value+'T00:00:00Z');
 if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==value)return null;
 return value>='2000-01-01'&&value<='2040-12-31'?value:null;
}

type Target={scope:EsuScope;name:string;groups:{id:string;name:string}[];customerId:string|null;customerName:string};
// The scope's groups that can pass a date on, innermost first, and its customer
// (which passes a date on to a group or device). The caller checked that the viewer may see the scope.
async function target(scope:EsuScope,name:string):Promise<Target>{
 if(scope.type==='customer')return {scope,name,groups:[],customerId:scope.id,customerName:name};
 const path=scope.type==='group'
  ?await db().query<{id:string;name:string}>(sql`SELECT g.id,g.name FROM device_group_ancestors a JOIN device_groups g ON g.id=a.ancestor_id WHERE a.group_id=${scope.id} AND a.ancestor_id<>${scope.id} ORDER BY a.depth ASC`)
  // A device: every group on its paths, the deepest from the root first (as resolveEsu in the console).
  :await db().query<{id:string;name:string}>(sql`SELECT g.id,g.name FROM device_groups g WHERE EXISTS (SELECT 1 FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id=${scope.id} AND a.ancestor_id=g.id) ORDER BY (SELECT MAX(depth) FROM device_group_ancestors root WHERE root.group_id=g.id) DESC,g.id`);
 const customer=await db().one<{customer_id:string|null;customer_name:string|null}>(scope.type==='group'
  ?sql`SELECT x.customer_id,c.name AS customer_name FROM device_groups x LEFT JOIN customers c ON c.id=x.customer_id WHERE x.id=${scope.id}`
  :sql`SELECT x.customer_id,c.name AS customer_name FROM servers x LEFT JOIN customers c ON c.id=x.customer_id WHERE x.id=${scope.id}`);
 return {scope,name,groups:path.map(group=>({id:String(group.id),name:String(group.name)})),customerId:customer?.customer_id??null,customerName:customer?.customer_name??''};
}
async function scopeRows(current:Target):Promise<EsuOverride[]>{
 const inheritsCustomer=current.scope.type!=='customer'&&current.customerId;
 const keys=JSON.stringify([`${current.scope.type}:${current.scope.id}`,...current.groups.map(group=>`group:${group.id}`),...(inheritsCustomer?[`customer:${current.customerId}`]:[])]);
 return rowsOf(await db().query<EsuRow>(sql`SELECT ${columns} FROM os_esu_overrides WHERE (scope_type || ':' || scope_id) IN (SELECT value FROM jsonb_array_elements_text(${keys}::jsonb))`));
}
const ownRow=(rows:EsuOverride[],scope:EsuScope)=>rows.find(row=>row.scopeType===scope.type&&row.scopeId===scope.id)??null;
// The closest group with a date, innermost first, else the customer of a group or device.
function inheritedRow(rows:EsuOverride[],current:Target):{row:EsuOverride;origin:{type:'customer'|'group';id:string;name:string}}|null{
 for(const group of current.groups){const row=rows.find(entry=>entry.scopeType==='group'&&entry.scopeId===group.id);if(row)return {row,origin:{type:'group',...group}};}
 if(current.scope.type==='customer'||!current.customerId)return null;
 const row=rows.find(entry=>entry.scopeType==='customer'&&entry.scopeId===current.customerId);
 return row?{row,origin:{type:'customer',id:row.scopeId,name:current.customerName}}:null;
}
function scopeGuard(v:Viewer,scope:EsuScope):SqlGuard{
 const me=sql`${principal(v)}`;
 if(scope.type==='customer')return sql`(${globalPermissionGuard(me,'alerts.manage')}) AND EXISTS (SELECT 1 FROM customers scope_customer WHERE scope_customer.id=${scope.id} AND ${customerAccessGuard(sql`scope_customer.id`,me)})`;
 // Both guards also require that the group or device exists and lies inside the customer boundary.
 return scope.type==='group'?groupPermissionGuard(sql`${scope.id}`,me,'alerts.manage'):devicePermissionGuard(sql`${scope.id}`,me,'alerts.manage');
}
async function readableTarget(v:Viewer,scope:EsuScope):Promise<Target>{
 if(scope.type==='customer'){const customer=await customerSeen(v,scope.id);if(!customer)throw new HttpError('apiError.customer.unavailable');return target(scope,customer.name);}
 if(scope.type==='group'){const group=await requireGroup(v,scope.id,'view');return target(scope,group.name);}
 const device=await requireDevice(v,scope.id,'view');return target(scope,device.name);
}
async function requireEditable(v:Viewer,scope:EsuScope):Promise<Target>{
 if(scope.type==='customer'){
  const customer=await customerSeen(v,scope.id);
  if(!customer)throw new HttpError('apiError.customer.unavailable');
  if(!await hasGlobalPermission(v,'alerts.manage'))throw new HttpError('apiError.esu.customerForbidden');
  return target(scope,customer.name);
 }
 if(scope.type==='group'){const group=await requireGroup(v,scope.id,'alerts.manage');return target(scope,group.name);}
 const device=await requireDevice(v,scope.id,'alerts.manage');return target(scope,device.name);
}

async function editState(v:Viewer,scope:EsuScope):Promise<{canEdit:boolean;reason:AlertEditReason|null}>{
 // The caller has checked that the viewer sees the customer.
 if(scope.type==='customer')return await hasGlobalPermission(v,'alerts.manage')?{canEdit:true,reason:null}:{canEdit:false,reason:'customer-right'};
 const rights=scope.type==='group'?await groupPermissions(v,scope.id):await permissionsFor(v,scope.id);
 return rights.includes('alerts.manage')?{canEdit:true,reason:null}:{canEdit:false,reason:'right'};
}

/** GET /api/os-support/esu?scopeType=customer|group|device&scopeId=<id>: 404 outside the customer boundary, 403 without view. */
export async function esuView(v:Viewer,params:URLSearchParams):Promise<EsuView>{
 const scope=parseScope(params.get('scopeType'),params.get('scopeId'));
 const current=await readableTarget(v,scope);
 const [rows,edit,visibleGroups]=await Promise.all([scopeRows(current),editState(v,scope),current.groups.length?allowedGroupIds(v,'view'):Promise.resolve([] as string[])]);
 const own=ownRow(rows,scope),inherited=inheritedRow(rows,current),visible=new Set(visibleGroups);
 // Whoever sees a group or device of the customer sees the customer.
 const originView=(origin:{type:'customer'|'group';id:string;name:string}):EsuOriginView=>({...origin,visible:origin.type==='customer'||visible.has(origin.id)});
 return {
  override:own?{until:own.until,updatedAt:own.updatedAt}:null,
  inherited:inherited?{until:inherited.row.until,origin:originView(inherited.origin)}:null,
  effective:own?.until??inherited?.row.until??null,
  ...edit,
 };
}

const originText=(value:{until:string;origin:string}|null)=>value??{until:null,origin:null};
/**
 * POST /api/os-support/esu: set-esu creates or replaces the date on the scope,
 * clear-esu deletes it. `expected` is the updatedAt of the date the client
 * showed (null: none); the committing statement holds only while it still
 * matches. Routine change: no step-up, the statement carries the live session
 * fence. One audit row commits with the change.
 */
export async function changeEsu(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;updatedAt:number|null}>{
 if(p.action!=='set-esu'&&p.action!=='clear-esu')throw new HttpError('apiError.request.unknownAction');
 const scope=parseScope(p.scopeType,p.scopeId);
 // The right comes before the body, as in POST /api/alert-rules: 403 without
 // alerts.manage (404 outside the customer boundary), whatever the body holds.
 const current=await requireEditable(v,scope);
 const expected=p.expected===null?null:typeof p.expected==='number'&&Number.isSafeInteger(p.expected)?p.expected:undefined;
 if(expected===undefined)throw invalid();
 const until=p.action==='set-esu'?validEsuDate(p.until):null;
 if(p.action==='set-esu'&&until===null)throw invalid();
 const rows=await scopeRows(current),own=ownRow(rows,scope);
 if((own?.updatedAt??null)!==expected)throw changed();
 if(p.action==='clear-esu'&&!own)throw changed();
 const inherited=inheritedRow(rows,current);
 const scopeText=`${scope.type}:${scope.id}`,inheritedValue=inherited?{until:inherited.row.until,origin:`${inherited.origin.type}:${inherited.origin.id}`}:null;
 const before=own?{until:own.until,origin:scopeText}:inheritedValue,after=until?{until,origin:scopeText}:inheritedValue;
 const auditTarget=JSON.stringify({scope:scopeText,old:originText(before),new:originText(after)});
 const fence=await mfaSessionFence(request,v),guard=sql`(${featureWriteGuard(v,scopeGuard(v,scope))}) AND (${fence})`,time=now();
 const match=sql`scope_type=${scope.type} AND scope_id=${scope.id}`;
 let statement;
 if(until&&expected===null)statement=sql`INSERT INTO os_esu_overrides(id,scope_type,scope_id,until,actor,updated_at) SELECT ${crypto.randomUUID()},${scope.type},${scope.id},${until},${v.label},${time} WHERE NOT EXISTS (SELECT 1 FROM os_esu_overrides existing WHERE existing.scope_type=${scope.type} AND existing.scope_id=${scope.id}) AND ${guard} ON CONFLICT (scope_type,scope_id) DO NOTHING RETURNING updated_at`;
 else if(until)statement=sql`UPDATE os_esu_overrides SET until=${until},actor=${v.label},updated_at=GREATEST(${time}::bigint,updated_at+1) WHERE ${match} AND updated_at=${expected} AND ${guard} RETURNING updated_at`;
 else statement=sql`DELETE FROM os_esu_overrides WHERE ${match} AND updated_at=${expected} AND ${guard} RETURNING updated_at`;
 const audit=auditEvent({actor:v.label,action:until?'os-esu.set':'os-esu.clear',target:auditTarget,guard:auditAfterChange,at:time,
  ...(scope.type==='device'?{serverIds:[scope.id]}:{customerId:current.customerId})});
 const row=await commitSessionChange(statement,audit);
 if(!row){
  // Refused in the transaction: a lost right or scope answers like the pre-check,
  // an ended session with its own 401; otherwise the date changed meanwhile.
  await requireEditable(v,scope);await requireLiveSessions(request,v);
  throw changed();
 }
 return {ok:true,updatedAt:until?Number(row.updated_at):null};
}
