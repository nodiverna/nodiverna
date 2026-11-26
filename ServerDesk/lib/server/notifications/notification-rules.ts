// Server side of the notification rules (docs/notifications.md): which levels
// and events of the alarms of a scope go to which channel. GET
// /api/notifications/rules?scope=all|group:<id>|customer:<id> returns the direct
// rules of the scope, the inherited ones nearest origin first and, only for a
// viewer who may change rules there, the channels for the picker; scope=device:<id>
// returns the rules that reach one device (read-only, the device Monitoring area).
// POST creates, updates and deletes direct rules of the three rule scopes. Rules are
// additive along a device's chain (lib/server/notifications/notification-routing.ts). Rights: a group
// needs alerts.manage on it; a customer needs global alerts.manage and sight of
// the customer; All devices needs global alerts.manage and sight of every
// customer. Routine changes (lib/step-up.ts): the statement carries the live
// session fence, and one audit row commits with it. Channel secrets never
// appear here. app/api/notifications/rules/route.ts is a thin adapter.
import {guid,HttpError,now} from '../context';
import {customerAccessGuard,globalPermissionGuard,groupPermissionGuard,groupPermissions,guardPasses,hasGlobalPermission,principal,requireDevice,requireGroup,type SqlGuard} from '../identity/access';
import {auditAfterChange,auditEvent} from '../audit';
import {featureWriteGuard} from '../identity/feature-authorization';
import {commitSessionChange} from '../identity/rbac';
import {mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import {alertLevels,type AlertLevel} from '../../alert-rules';
import {customerSeparationSql} from '../../../runtime/customer-separation.mjs';
import {db,sql,type Sql} from '../db';
import type {Viewer} from '../../types';
import type {ChannelType} from './notify/send';

export type RuleScopeType='all'|'customer'|'group';
export type RuleScope={type:RuleScopeType;id:string};
/** The scopes a rule view can show: the three rule scopes, and a device (read-only: the rules that reach it). */
export type RuleViewScopeType=RuleScopeType|'device';
export type RuleEvents={open:boolean;close:boolean;escalate:boolean};
export type RuleChannel={id:string;name:string;type:ChannelType;enabled:boolean};
export type NotificationRuleView={id:string;scope:RuleScope;channel:RuleChannel;levels:AlertLevel[];events:RuleEvents;enabled:boolean;revision:number};
export type RuleOrigin={type:RuleScopeType;id:string;name:string;
 /** Whether the viewer may open the origin (a group they see). */
 visible:boolean};
export type InheritedRuleView=NotificationRuleView&{origin:RuleOrigin};
export type RuleEditReason='right'|'customer-boundary';
export type NotificationRulesView={
 scope:{type:RuleViewScopeType;id:string;name:string};direct:NotificationRuleView[];inherited:InheritedRuleView[];channels:RuleChannel[];
 canEdit:boolean;reason:RuleEditReason|null;
};
type RuleRow={id:string;scope_type:RuleScopeType;scope_id:string;channel_id:string;levels:string;on_open:number;on_close:number;on_escalate:number;enabled:number;revision:number|string;channel_name:string;channel_type:ChannelType;channel_enabled:number};

const invalid=(field:'scope'|'channel'|'levels'|'events'|'enabled'|'id'|'revision')=>new HttpError('apiError.notify.ruleInvalid',{field});
const changed=()=>new HttpError('apiError.notify.ruleChanged');
const exists=()=>new HttpError('apiError.notify.ruleExists');
const scopeKey=(scope:RuleScope)=>scope.type==='all'?'all':`${scope.type}:${scope.id}`;

/** all, group:<id> or customer:<id>; anything else (also device:<id>, which has no rules of its own) is 400 NOTIFY_RULE_INVALID (scope). */
export function parseRuleScope(value:unknown):RuleScope{
 if(value==='all')return {type:'all',id:'*'};
 const match=typeof value==='string'?/^(group|customer):(.+)$/.exec(value):null;
 if(!match||!guid(match[2]))throw invalid('scope');
 return {type:match[1] as RuleScopeType,id:match[2].toLowerCase()};
}
/** The chosen levels in catalog order, at least one. */
export function parseLevels(value:unknown):AlertLevel[]{
 if(!Array.isArray(value)||!value.length||value.some(level=>!alertLevels.includes(level as AlertLevel))||new Set(value).size!==value.length)throw invalid('levels');
 return alertLevels.filter(level=>value.includes(level));
}
export function parseEvents(value:unknown):RuleEvents{
 const events=value as Partial<RuleEvents>|null;
 if(!events||typeof events!=='object'||typeof events.open!=='boolean'||typeof events.close!=='boolean'||typeof events.escalate!=='boolean'||!(events.open||events.close||events.escalate))throw invalid('events');
 return {open:events.open,close:events.close,escalate:events.escalate};
}

const columns=sql`r.id,r.scope_type,r.scope_id,r.channel_id,r.levels,r.on_open,r.on_close,r.on_escalate,r.enabled,r.revision,c.name AS channel_name,c.type AS channel_type,c.enabled AS channel_enabled`;
const levelsOf=(text:string):AlertLevel[]=>{try{const value=JSON.parse(text);return Array.isArray(value)?alertLevels.filter(level=>value.includes(level)):[];}catch{return [];}};
const viewOf=(row:RuleRow):NotificationRuleView=>({id:row.id,scope:{type:row.scope_type,id:row.scope_id},channel:{id:row.channel_id,name:row.channel_name,type:row.channel_type,enabled:Number(row.channel_enabled)===1},
 levels:levelsOf(row.levels),events:{open:Number(row.on_open)===1,close:Number(row.on_close)===1,escalate:Number(row.on_escalate)===1},enabled:Number(row.enabled)===1,revision:Number(row.revision)});

/** True while the actor sees every customer: rules for All devices reach all of them. */
function allCustomersGuard(v:Viewer):SqlGuard{return sql`NOT EXISTS (SELECT 1 FROM customers boundary_customer WHERE NOT ${customerAccessGuard(sql`boundary_customer.id`,sql`${principal(v)}`)})`;}
function scopeGuard(v:Viewer,scope:RuleScope):SqlGuard{
 const me=sql`${principal(v)}`;
 if(scope.type==='all')return sql`(${globalPermissionGuard(me,'alerts.manage')}) AND (${allCustomersGuard(v)})`;
 if(scope.type==='group')return groupPermissionGuard(sql`${scope.id}`,me,'alerts.manage');
 return sql`(${globalPermissionGuard(me,'alerts.manage')}) AND EXISTS (SELECT 1 FROM customers scope_customer WHERE scope_customer.id=${scope.id} AND ${customerAccessGuard(sql`scope_customer.id`,me)})`;
}

type Target={scope:RuleScope;name:string;customerId:string|null;
 /** The origins whose rules this scope inherits, nearest first. */
 chain:RuleOrigin[]};
async function customerSeen(v:Viewer,id:string){return db().one<{id:string;name:string}>(sql`SELECT id,name FROM customers WHERE id=${id} AND ${customerAccessGuard(sql`customers.id`,sql`${principal(v)}`)}`);}
const multipleCustomers=async()=>!!await db().one(sql`SELECT 1 AS active WHERE ${customerSeparationSql}`);
/** The scope with its inheritance chain. The caller has checked that the viewer may see it. */
async function target(v:Viewer,scope:RuleScope,name:string):Promise<Target>{
 const all:RuleOrigin={type:'all',id:'*',name:'',visible:true};
 if(scope.type==='all')return {scope,name,customerId:null,chain:[]};
 if(scope.type==='customer')return {scope,name,customerId:scope.id,chain:[all]};
 const [ancestors,group,active,visible]=await Promise.all([
  db().query<{id:string;name:string}>(sql`SELECT g.id,g.name FROM device_group_ancestors a JOIN device_groups g ON g.id=a.ancestor_id WHERE a.group_id=${scope.id} AND a.ancestor_id<>${scope.id} ORDER BY a.depth`),
  db().one<{customer_id:string|null;customer_name:string|null}>(sql`SELECT g.customer_id,c.name AS customer_name FROM device_groups g LEFT JOIN customers c ON c.id=g.customer_id WHERE g.id=${scope.id}`),
  multipleCustomers(),
  db().query<{id:string}>(sql`SELECT id FROM device_groups WHERE ${groupPermissionGuard(sql`device_groups.id`,sql`${principal(v)}`,'view')}`),
 ]);
 const seen=new Set(visible.map(row=>row.id));
 const chain:RuleOrigin[]=ancestors.map(row=>({type:'group',id:row.id,name:row.name,visible:seen.has(row.id)}));
 if(active&&group?.customer_id)chain.push({type:'customer',id:group.customer_id,name:group.customer_name??'',visible:true});
 chain.push(all);
 return {scope,name,customerId:group?.customer_id??null,chain};
}
/** Loads the scope for reading: 404 outside the customer boundary, 403 without view. */
async function readableTarget(v:Viewer,scope:RuleScope):Promise<Target>{
 if(scope.type==='all')return target(v,scope,'');
 if(scope.type==='group'){const group=await requireGroup(v,scope.id,'view');return target(v,scope,group.name);}
 const customer=await customerSeen(v,scope.id);
 if(!customer)throw new HttpError('apiError.customer.unavailable');
 return target(v,scope,customer.name);
}
/** The right to change rules on the scope, with the status of the first refusal. */
async function requireEditable(v:Viewer,scope:RuleScope):Promise<Target>{
 if(scope.type==='all'){
  if(!await hasGlobalPermission(v,'alerts.manage'))throw new HttpError('apiError.notify.allDevicesForbidden');
  if(!await guardPasses(allCustomersGuard(v)))throw new HttpError('apiError.notify.scopeBoundary');
  return target(v,scope,'');
 }
 if(scope.type==='group'){const group=await requireGroup(v,scope.id,'alerts.manage');return target(v,scope,group.name);}
 const customer=await customerSeen(v,scope.id);
 if(!customer)throw new HttpError('apiError.customer.unavailable');
 if(!await hasGlobalPermission(v,'alerts.manage'))throw new HttpError('apiError.notify.customerForbidden');
 return target(v,scope,customer.name);
}
async function editState(v:Viewer,scope:RuleScope):Promise<{canEdit:boolean;reason:RuleEditReason|null}>{
 if(scope.type==='group')return (await groupPermissions(v,scope.id)).includes('alerts.manage')?{canEdit:true,reason:null}:{canEdit:false,reason:'right'};
 if(!await hasGlobalPermission(v,'alerts.manage'))return {canEdit:false,reason:'right'};
 if(scope.type==='all'&&!await guardPasses(allCustomersGuard(v)))return {canEdit:false,reason:'customer-boundary'};
 return {canEdit:true,reason:null};
}

/** The rules of the given scope keys, in channel name order. */
const rulesOf=(keys:readonly string[])=>db().query<RuleRow>(sql`SELECT ${columns} FROM notification_rules r JOIN notification_channels c ON c.id=r.channel_id WHERE (CASE WHEN r.scope_type='all' THEN 'all' ELSE r.scope_type || ':' || r.scope_id END) IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)) ORDER BY lower(c.name),r.id`);

/**
 * The origins whose rules reach a device, nearest first, with the same sources as the routing (lib/server/notifications/notifications.ts and
 * ruleCovers in lib/server/notifications/notification-routing.ts): its groups, direct memberships and their ancestors from device_group_members
 * and device_group_ancestors, by depth (a group reached on two paths counts at its nearest) and then by name; its customer
 * only once a second customer exists; then All devices.
 */
async function deviceChain(v:Viewer,deviceId:string):Promise<RuleOrigin[]>{
 const [groups,customer,active,visible]=await Promise.all([
  db().query<{id:string;name:string}>(sql`SELECT g.id,g.name FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id JOIN device_groups g ON g.id=a.ancestor_id WHERE m.server_id=${deviceId} GROUP BY g.id,g.name ORDER BY min(a.depth),g.name,g.id`),
  db().one<{customer_id:string|null;customer_name:string|null}>(sql`SELECT s.customer_id,c.name AS customer_name FROM servers s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=${deviceId}`),
  multipleCustomers(),
  db().query<{id:string}>(sql`SELECT id FROM device_groups WHERE ${groupPermissionGuard(sql`device_groups.id`,sql`${principal(v)}`,'view')}`),
 ]);
 const seen=new Set(visible.map(row=>row.id));
 const chain:RuleOrigin[]=groups.map(row=>({type:'group',id:row.id,name:row.name,visible:seen.has(row.id)}));
 if(active&&customer?.customer_id)chain.push({type:'customer',id:customer.customer_id,name:customer.customer_name??'',visible:true});
 chain.push({type:'all',id:'*',name:'',visible:true});
 return chain;
}

/**
 * GET /api/notifications/rules?scope=device:<id>: every rule that reaches the device (ruleCovers), nearest origin first,
 * disabled rules and rules of disabled channels included with their flags. A device has no rules of its own, so direct
 * and channels are empty and nobody may edit here. The device is read with requireDevice (view); an id that is no GUID
 * is 400 NOTIFY_RULE_INVALID (scope).
 */
async function deviceRulesView(v:Viewer,id:string):Promise<NotificationRulesView>{
 if(!guid(id))throw invalid('scope');
 const device=await requireDevice(v,id.toLowerCase(),'view');
 const chain=await deviceChain(v,device.id);
 const views=(await rulesOf(chain.map(scopeKey))).map(viewOf);
 return {
  scope:{type:'device',id:device.id,name:device.name},direct:[],
  inherited:chain.flatMap(origin=>views.filter(rule=>scopeKey(rule.scope)===scopeKey(origin)).map(rule=>({...rule,origin}))),
  channels:[],canEdit:false,reason:null,
 };
}

/**
 * GET /api/notifications/rules?scope=all|group:<id>|customer:<id>|device:<id>. The channel
 * list is instance-wide: a viewer who cannot change rules on the scope gets an
 * empty list, and the query does not run. Rules keep their own channel.
 */
export async function notificationRulesView(v:Viewer,params:URLSearchParams):Promise<NotificationRulesView>{
 const requested=params.get('scope');
 if(requested?.startsWith('device:'))return deviceRulesView(v,requested.slice('device:'.length));
 const scope=parseRuleScope(requested);
 const current=await readableTarget(v,scope);
 const [rows,edit]=await Promise.all([
  rulesOf([scopeKey(scope),...current.chain.map(origin=>scopeKey(origin))]),
  editState(v,scope),
 ]);
 const channels=edit.canEdit?await db().query<{id:string;name:string;type:ChannelType;enabled:number}>(sql`SELECT id,name,type,enabled FROM notification_channels ORDER BY lower(name),id`):[];
 const views=rows.map(viewOf),own=scopeKey(scope);
 return {
  scope:{...scope,name:current.name},
  direct:views.filter(rule=>scopeKey(rule.scope)===own),
  inherited:current.chain.flatMap(origin=>views.filter(rule=>scopeKey(rule.scope)===scopeKey(origin)).map(rule=>({...rule,origin}))),
  channels:channels.map(row=>({id:row.id,name:row.name,type:row.type,enabled:Number(row.enabled)===1})),
  ...edit,
 };
}

const auditValues=(rule:{channelId:string;levels:AlertLevel[];events:RuleEvents;enabled:boolean})=>({channel:rule.channelId,levels:rule.levels,events:rule.events,enabled:rule.enabled});

/**
 * POST /api/notifications/rules: create {scope, channelId, levels, events,
 * enabled}, update {scope, id, revision, levels, events, enabled} and delete
 * {scope, id, revision}. The right on the scope comes before the body (403
 * before 400). A stale revision answers 409 NOTIFY_RULE_CHANGED.
 */
export async function changeNotificationRule(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;id:string;revision:number|null}>{
 if(p.action!=='create'&&p.action!=='update'&&p.action!=='delete')throw new HttpError('apiError.request.unknownAction');
 const scope=parseRuleScope(p.scope);
 const current=await requireEditable(v,scope);
 const time=now(),scopeText=scopeKey(scope);
 const fence=await mfaSessionFence(request,v),guard=sql`(${featureWriteGuard(v,scopeGuard(v,scope))}) AND (${fence})`;
 const auditScope=scope.type==='all'?{customerId:null}:{customerId:current.customerId};
 let statement:Sql,action:string,target:Record<string,unknown>,id:string,revision:number|null;
 if(p.action==='create'){
  if(!guid(p.channelId))throw invalid('channel');
  const channelId=p.channelId.toLowerCase(),levels=parseLevels(p.levels),events=parseEvents(p.events),enabled=p.enabled===undefined?true:p.enabled;
  if(typeof enabled!=='boolean')throw invalid('enabled');
  if(!await db().one(sql`SELECT 1 AS found FROM notification_channels WHERE id=${channelId}`))throw invalid('channel');
  if(await db().one(sql`SELECT 1 AS found FROM notification_rules WHERE scope_type=${scope.type} AND scope_id=${scope.id} AND channel_id=${channelId}`))throw exists();
  id=crypto.randomUUID();revision=0;
  statement=sql`INSERT INTO notification_rules(id,scope_type,scope_id,channel_id,levels,on_open,on_close,on_escalate,enabled,revision,created_at,created_by,updated_at,updated_by)
   SELECT ${id},${scope.type},${scope.id},${channelId},${JSON.stringify(levels)},${events.open?1:0},${events.close?1:0},${events.escalate?1:0},${enabled?1:0},0,${time},${v.label},${time},${v.label}
   WHERE EXISTS (SELECT 1 FROM notification_channels WHERE id=${channelId}) AND ${guard} ON CONFLICT DO NOTHING RETURNING revision`;
  action='notification-rule.create';target={id,scope:scopeText,...auditValues({channelId,levels,events,enabled})};
 }else{
  if(!guid(p.id))throw invalid('id');
  if(typeof p.revision!=='number'||!Number.isSafeInteger(p.revision)||p.revision<0)throw invalid('revision');
  id=p.id.toLowerCase();
  const expected=p.revision;
  const row=await db().one<RuleRow>(sql`SELECT ${columns} FROM notification_rules r JOIN notification_channels c ON c.id=r.channel_id WHERE r.id=${id} AND r.scope_type=${scope.type} AND r.scope_id=${scope.id}`);
  if(!row)throw new HttpError('apiError.notify.ruleNotFound');
  if(Number(row.revision)!==expected)throw changed();
  const before={channelId:row.channel_id,levels:levelsOf(row.levels),events:{open:Number(row.on_open)===1,close:Number(row.on_close)===1,escalate:Number(row.on_escalate)===1},enabled:Number(row.enabled)===1};
  const match=sql`id=${id} AND revision=${expected} AND scope_type=${scope.type} AND scope_id=${scope.id}`;
  if(p.action==='delete'){
   statement=sql`DELETE FROM notification_rules WHERE ${match} AND ${guard} RETURNING revision`;
   action='notification-rule.delete';target={id,scope:scopeText,...auditValues(before),old:auditValues(before)};revision=null;
  }else{
   const levels=parseLevels(p.levels),events=parseEvents(p.events),enabled=p.enabled===undefined?before.enabled:p.enabled;
   if(typeof enabled!=='boolean')throw invalid('enabled');
   const after={channelId:row.channel_id,levels,events,enabled};
   if(JSON.stringify(auditValues(after))===JSON.stringify(auditValues(before)))return {ok:true,id,revision:expected};
   statement=sql`UPDATE notification_rules SET levels=${JSON.stringify(levels)},on_open=${events.open?1:0},on_close=${events.close?1:0},on_escalate=${events.escalate?1:0},enabled=${enabled?1:0},revision=revision+1,updated_at=${time},updated_by=${v.label} WHERE ${match} AND ${guard} RETURNING revision`;
   action='notification-rule.update';target={id,scope:scopeText,...auditValues(after),old:auditValues(before),new:auditValues(after)};revision=expected+1;
  }
 }
 const audit=auditEvent({actor:v.label,action,target:JSON.stringify(target),guard:auditAfterChange,at:time,...auditScope});
 const row=await commitSessionChange(statement,audit);
 if(!row){
  // Refused in the transaction: a lost right answers like the pre-check, an
  // ended session with its own 401; otherwise the rule changed or exists already.
  await requireEditable(v,scope);await requireLiveSessions(request,v);
  if(p.action==='create'&&await db().one(sql`SELECT 1 AS found FROM notification_rules WHERE scope_type=${scope.type} AND scope_id=${scope.id} AND channel_id=${String(p.channelId).toLowerCase()}`))throw exists();
  throw changed();
 }
 return {ok:true,id,revision};
}
