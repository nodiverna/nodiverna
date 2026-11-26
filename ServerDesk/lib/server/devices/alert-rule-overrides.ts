// Server side of the alert rules (lib/alert-rules.ts): the stored overrides per
// scope (All devices, customer, group, device), the rule table of GET
// /api/alert-rules and the two changes set-rule and reset-rule of POST
// /api/alert-rules. app/api/alert-rules/route.ts is a thin
// adapter around this module; the console route reads the overrides of every
// visible device through consoleAlertOverrides in one statement.
import {guid,HttpError,now} from '../context';
import {allowedGroupIds,customerAccessGuard,devicePermissionGuard,globalPermissionGuard,groupPermissionGuard,groupPermissions,guardPasses,hasGlobalPermission,permissionsFor,principal,requireDevice,requireGroup,type SqlGuard} from '../identity/access';
import {auditAfterChange,auditEvent} from '../audit';
import {featureWriteGuard} from '../identity/feature-authorization';
import {commitSessionChange} from '../identity/rbac';
import {mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import type {Viewer} from '../../types';
import {db,sql,type Queryable} from '../db';
import {alertRules,isAlertRuleId,isAlertScopeType,resolveAlertRules,validateAlertRuleSettings,type AlertEditReason,type AlertLevel,type AlertOrigin,type AlertOriginView,type AlertRuleId,type AlertRuleOverride,type AlertRuleSettings,type AlertRuleView,type AlertScope} from '../../alert-rules';

type OverrideRow={rule_id:string;scope_type:string;scope_id:string;enabled:number;warning:number|null;critical:number|null;level:string|null;duration_minutes:number|null;recovery:number|null;updated_at:number};
const columns=sql`rule_id,scope_type,scope_id,enabled,warning,critical,level,duration_minutes,recovery,updated_at`;
const numberOrNull=(value:unknown)=>value===null||value===undefined?null:Number(value);
// Rows of unknown rules (a rule removed from the catalog) are ignored.
function overrides(rows:OverrideRow[]):AlertRuleOverride[]{
 return rows.flatMap(row=>isAlertRuleId(row.rule_id)&&isAlertScopeType(row.scope_type)?[{ruleId:row.rule_id,scopeType:row.scope_type,scopeId:String(row.scope_id),enabled:Number(row.enabled)===1,warning:numberOrNull(row.warning),critical:numberOrNull(row.critical),level:row.level as AlertLevel|null,durationMinutes:numberOrNull(row.duration_minutes),recovery:numberOrNull(row.recovery),updatedAt:Number(row.updated_at)}]:[]);
}
/**
 * The overrides that can apply to the visible devices (`scope`, the JSON array of
 * their IDs): global ones, those of their customers, those of every group on
 * their group paths and their own. One statement, whatever the number of
 * devices. The alarm state (lib/server/devices/alerts.ts) reads them through its
 * transaction handle `q`.
 */
export async function consoleAlertOverrides(scope:string,q:Queryable=db()):Promise<AlertRuleOverride[]>{
 return overrides(await q.query<OverrideRow>(sql`SELECT ${columns} FROM alert_rule_overrides WHERE scope_type='global'
  OR (scope_type='device' AND scope_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)))
  OR (scope_type='customer' AND scope_id IN (SELECT s.customer_id FROM servers s WHERE s.id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))))
  OR (scope_type='group' AND scope_id IN (SELECT a.ancestor_id FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))))`));
}
async function chainOverrides(chain:AlertScope[]):Promise<AlertRuleOverride[]>{
 const keys=JSON.stringify(chain.map(scope=>`${scope.type}:${scope.id}`));
 return overrides(await db().query<OverrideRow>(sql`SELECT ${columns} FROM alert_rule_overrides WHERE (scope_type || ':' || scope_id) IN (SELECT value FROM jsonb_array_elements_text(${keys}::jsonb))`));
}

type Target={scope:AlertScope;name:string;chain:AlertScope[];names:Map<string,string>;customerId:string|null;customerName:string};
const key=(scope:{type:string;id:string})=>`${scope.type}:${scope.id}`;
function parseScope(type:unknown,id:unknown):AlertScope{
 if(!isAlertScopeType(type))throw invalid();
 if(type==='global'){if(id!=='*')throw invalid();return {type,id:'*'};}
 if(!guid(id))throw invalid();
 return {type,id:id.toLowerCase()};
}
const invalid=()=>new HttpError('apiError.alerts.invalid');
const changed=()=>new HttpError('apiError.alerts.changed');
/** The customer with its name while the viewer sees it (inside the customer boundary), else null. */
export async function customerSeen(v:Viewer,id:string){return db().one<{id:string;name:string}>(sql`SELECT id,name FROM customers WHERE id=${id} AND ${customerAccessGuard(sql`customers.id`,sql`${principal(v)}`)}`);}
// The scope with its chain, outermost first: global, the customer, the groups
// (and the device), and the names of its groups and customer. The caller has
// checked that the viewer may see the scope.
async function target(scope:AlertScope,name:string):Promise<Target>{
 if(scope.type==='global')return {scope,name,chain:[scope],names:new Map(),customerId:null,customerName:''};
 if(scope.type==='customer')return {scope,name,chain:[{type:'global',id:'*'},scope],names:new Map(),customerId:scope.id,customerName:name};
 const path=scope.type==='group'
  ?await db().query<{id:string;name:string}>(sql`SELECT g.id,g.name FROM device_group_ancestors a JOIN device_groups g ON g.id=a.ancestor_id WHERE a.group_id=${scope.id} ORDER BY a.depth DESC`)
  :await db().query<{id:string;name:string}>(sql`SELECT g.id,g.name FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id JOIN device_groups g ON g.id=a.ancestor_id WHERE m.server_id=${scope.id} ORDER BY a.depth DESC,g.id`);
 const groups=scope.type==='group'?path:[...new Map(path.map(group=>[group.id,group])).values()];
 const customer=await db().one<{customer_id:string|null;customer_name:string|null}>(scope.type==='group'
  ?sql`SELECT x.customer_id,c.name AS customer_name FROM device_groups x LEFT JOIN customers c ON c.id=x.customer_id WHERE x.id=${scope.id}`
  :sql`SELECT x.customer_id,c.name AS customer_name FROM servers x LEFT JOIN customers c ON c.id=x.customer_id WHERE x.id=${scope.id}`);
 const customerId=customer?.customer_id??null;
 const chain:AlertScope[]=[{type:'global',id:'*'},...(customerId?[{type:'customer' as const,id:customerId}]:[]),...groups.map(group=>({type:'group' as const,id:group.id}))];
 if(scope.type==='device')chain.push(scope);
 return {scope,name,chain,names:new Map(groups.map(group=>[group.id,group.name])),customerId,customerName:customer?.customer_name??''};
}
/** True while the actor sees every customer: rules for All devices apply to all of them. */
function allCustomersGuard(v:Viewer):SqlGuard{return sql`NOT EXISTS (SELECT 1 FROM customers boundary_customer WHERE NOT ${customerAccessGuard(sql`boundary_customer.id`,sql`${principal(v)}`)})`;}
/**
 * The guard of a change on this scope: group, device or global right plus the
 * customer boundary. A customer needs the global alerts.manage and sight of the
 * customer, as notification rules on a customer.
 */
function scopeGuard(v:Viewer,scope:AlertScope):SqlGuard{
 const me=sql`${principal(v)}`;
 if(scope.type==='global')return sql`(${globalPermissionGuard(me,'alerts.manage')}) AND (${allCustomersGuard(v)})`;
 if(scope.type==='customer')return sql`(${globalPermissionGuard(me,'alerts.manage')}) AND EXISTS (SELECT 1 FROM customers scope_customer WHERE scope_customer.id=${scope.id} AND ${customerAccessGuard(sql`scope_customer.id`,me)})`;
 // The group guard also requires that the group exists and lies inside the boundary.
 if(scope.type==='group')return groupPermissionGuard(sql`${scope.id}`,me,'alerts.manage');
 return devicePermissionGuard(sql`${scope.id}`,me,'alerts.manage');
}

/** Loads the scope for reading: 404 outside the customer boundary, 403 without view. */
async function readableTarget(v:Viewer,scope:AlertScope):Promise<Target>{
 if(scope.type==='global')return target(scope,'');
 if(scope.type==='customer'){const customer=await customerSeen(v,scope.id);if(!customer)throw new HttpError('apiError.customer.unavailable');return target(scope,customer.name);}
 if(scope.type==='group'){const group=await requireGroup(v,scope.id,'view');return target(scope,group.name);}
 const device=await requireDevice(v,scope.id,'view');return target(scope,device.name);
}
/** Checks the right to change rules on the scope, with the status of the first refusal. */
async function requireEditable(v:Viewer,scope:AlertScope):Promise<Target>{
 if(scope.type==='global'){
  if(!await hasGlobalPermission(v,'alerts.manage'))throw new HttpError('apiError.alerts.allDevicesForbidden');
  if(!await guardPasses(allCustomersGuard(v)))throw new HttpError('apiError.alerts.scopeBoundary');
  return target(scope,'');
 }
 if(scope.type==='customer'){
  const customer=await customerSeen(v,scope.id);
  if(!customer)throw new HttpError('apiError.customer.unavailable');
  if(!await hasGlobalPermission(v,'alerts.manage'))throw new HttpError('apiError.alerts.customerForbidden');
  return target(scope,customer.name);
 }
 if(scope.type==='group'){const group=await requireGroup(v,scope.id,'alerts.manage');return target(scope,group.name);}
 const device=await requireDevice(v,scope.id,'alerts.manage');return target(scope,device.name);
}
async function editState(v:Viewer,scope:AlertScope):Promise<{canEdit:boolean;reason:AlertEditReason|null}>{
 if(scope.type==='global'){
  if(!await hasGlobalPermission(v,'alerts.manage'))return {canEdit:false,reason:'right'};
  return await guardPasses(allCustomersGuard(v))?{canEdit:true,reason:null}:{canEdit:false,reason:'customer-boundary'};
 }
 // The caller has checked that the viewer sees the customer.
 if(scope.type==='customer')return await hasGlobalPermission(v,'alerts.manage')?{canEdit:true,reason:null}:{canEdit:false,reason:'customer-right'};
 const rights=scope.type==='group'?await groupPermissions(v,scope.id):await permissionsFor(v,scope.id);
 return rights.includes('alerts.manage')?{canEdit:true,reason:null}:{canEdit:false,reason:'right'};
}

const originText=(origin:AlertOrigin)=>origin.type==='default'?'default':origin.type==='global'?'global':`${origin.type}:${origin.id}`;
const settingsOf=(value:AlertRuleSettings):AlertRuleSettings=>({enabled:value.enabled,warning:value.warning,critical:value.critical,level:value.level,durationMinutes:value.durationMinutes,recovery:value.recovery});

/** GET /api/alert-rules?scopeType=global|customer|group|device&scopeId=<id> ('*' for global). */
export async function alertRuleView(v:Viewer,params:URLSearchParams):Promise<AlertRuleView>{
 const scope=parseScope(params.get('scopeType'),params.get('scopeId'));
 const current=await readableTarget(v,scope);
 const [rows,edit,visibleGroups]=await Promise.all([chainOverrides(current.chain),editState(v,scope),current.names.size?allowedGroupIds(v,'view'):Promise.resolve([] as string[])]);
 const visible=new Set(visibleGroups);
 const originView=(origin:AlertOrigin):AlertOriginView=>{
  if(origin.type==='default')return origin;
  if(origin.type==='global')return {type:'global',id:'*',name:'',visible:true};
  // Whoever sees a group or device of the customer sees the customer.
  if(origin.type==='customer')return {type:'customer',id:origin.id,name:current.customerName,visible:true};
  if(origin.type==='group')return {type:'group',id:origin.id,name:current.names.get(origin.id)??'',visible:visible.has(origin.id)};
  return {type:'device',id:origin.id,name:current.name,visible:true};
 };
 const effective=resolveAlertRules(rows,current.chain),inherited=resolveAlertRules(rows,current.chain.slice(0,-1));
 const direct=new Map(rows.filter(row=>key({type:row.scopeType,id:row.scopeId})===key(scope)).map(row=>[row.ruleId,row]));
 return {
  scope:{type:scope.type,id:scope.id,name:current.name},
  rules:alertRules.map(rule=>{const own=direct.get(rule.id);return {ruleId:rule.id,effective:effective[rule.id].settings,origin:originView(effective[rule.id].origin),override:own?{...settingsOf(own),updatedAt:own.updatedAt}:null,inherited:{settings:inherited[rule.id].settings,origin:originView(inherited[rule.id].origin)}};}),
  ...edit,
 };
}

/**
 * POST /api/alert-rules: set-rule creates or replaces the override on the scope,
 * reset-rule deletes it. `expected` is the updated_at of the override the client
 * showed (null: none); the committing statement holds only while it still
 * matches. Routine change (lib/step-up.ts): no step-up proof, the statement
 * carries the live session fence. One audit row commits with the change.
 */
export async function changeAlertRule(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;updatedAt:number|null}>{
 if(p.action!=='set-rule'&&p.action!=='reset-rule')throw new HttpError('apiError.request.unknownAction');
 const scope=parseScope(p.scopeType,p.scopeId);
 // The right comes before the body: a caller without alerts.manage gets 403
 // (404 outside the customer boundary), whatever else the body contains.
 const current=await requireEditable(v,scope);
 const expected=p.expected===null?null:typeof p.expected==='number'&&Number.isSafeInteger(p.expected)?p.expected:undefined;
 if(expected===undefined)throw invalid();
 let ruleId:AlertRuleId,settings:AlertRuleSettings|null=null;
 if(p.action==='set-rule'){
  const result=validateAlertRuleSettings(p.ruleId,{enabled:p.enabled,warning:p.warning,critical:p.critical,level:p.level,durationMinutes:p.durationMinutes,recovery:p.recovery});
  if(!result.ok)throw invalid();
  ruleId=result.ruleId;settings=result.settings;
 }else{
  if(!isAlertRuleId(p.ruleId))throw invalid();
  ruleId=p.ruleId;
 }
 const rows=await chainOverrides(current.chain),own=rows.find(row=>row.ruleId===ruleId&&key({type:row.scopeType,id:row.scopeId})===key(scope));
 if((own?.updatedAt??null)!==expected)throw changed();
 const before=resolveAlertRules(rows,current.chain)[ruleId];
 const after=settings?{settings,origin:scope as AlertOrigin}:resolveAlertRules(rows.filter(row=>row!==own),current.chain)[ruleId];
 const scopeText=scope.type==='global'?'global':`${scope.type}:${scope.id}`;
 const auditTarget=JSON.stringify({rule:ruleId,scope:scopeText,old:{...settingsOf(before.settings),origin:originText(before.origin)},new:{...settingsOf(after.settings),origin:originText(after.origin)}});
 const fence=await mfaSessionFence(request,v),guard=sql`(${featureWriteGuard(v,scopeGuard(v,scope))}) AND (${fence})`,time=now();
 const match=sql`rule_id=${ruleId} AND scope_type=${scope.type} AND scope_id=${scope.id}`;
 let statement;
 if(settings&&expected===null)statement=sql`INSERT INTO alert_rule_overrides(id,rule_id,scope_type,scope_id,enabled,warning,critical,level,duration_minutes,recovery,actor,updated_at) SELECT ${crypto.randomUUID()},${ruleId},${scope.type},${scope.id},${settings.enabled?1:0},${settings.warning}::integer,${settings.critical}::integer,${settings.level}::text,${settings.durationMinutes}::integer,${settings.recovery}::integer,${v.label},${time} WHERE NOT EXISTS (SELECT 1 FROM alert_rule_overrides existing WHERE existing.rule_id=${ruleId} AND existing.scope_type=${scope.type} AND existing.scope_id=${scope.id}) AND ${guard} ON CONFLICT (rule_id,scope_type,scope_id) DO NOTHING RETURNING updated_at`;
 else if(settings)statement=sql`UPDATE alert_rule_overrides SET enabled=${settings.enabled?1:0},warning=${settings.warning}::integer,critical=${settings.critical}::integer,level=${settings.level}::text,duration_minutes=${settings.durationMinutes}::integer,recovery=${settings.recovery}::integer,actor=${v.label},updated_at=GREATEST(${time}::bigint,updated_at+1) WHERE ${match} AND updated_at=${expected} AND ${guard} RETURNING updated_at`;
 else{if(expected===null)throw changed();statement=sql`DELETE FROM alert_rule_overrides WHERE ${match} AND updated_at=${expected} AND ${guard} RETURNING updated_at`;}
 const audit=auditEvent({actor:v.label,action:settings?'alert-rule.set':'alert-rule.reset',target:auditTarget,guard:auditAfterChange,at:time,
  ...(scope.type==='device'?{serverIds:[scope.id]}:{customerId:scope.type==='global'?null:current.customerId})});
 const row=await commitSessionChange(statement,audit);
 if(!row){
  // Refused in the transaction: a lost right or scope answers like the pre-check,
  // an ended session with its own 401; otherwise the override changed meanwhile.
  await requireEditable(v,scope);await requireLiveSessions(request,v);
  throw changed();
 }
 return {ok:true,updatedAt:settings?Number(row.updated_at):null};
}
