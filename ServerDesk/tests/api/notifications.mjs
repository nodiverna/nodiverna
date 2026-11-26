// Notifications against PostgreSQL through the real routes and modules: real
// POST /api/heartbeat calls write open, escalate and close events in the alarm
// transaction (a failing event insert rolls the alarm back), unchanged
// heartbeats add none; the dispatcher (lib/server/notifications/notifications.ts) with its lease,
// overlapping runs that send each delivery once, bundling, the retry schedule,
// stale sending rows, suppression; the message content; the rules API with its
// rights per scope, 403 before 400, the customer boundary, audit rows and
// revision 409; the delivery log filtered to visible devices; and emergency
// sign-ins (routed without rules to the Owner addresses, sent alone, retried
// with their stored recipients, their message in en and de). The send
// module is a fake that counts calls (lib/server/notifications/notify/send.ts is tested on its own).
import {serverText} from '../support/server-text.mjs';
import {HttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {createKeyring,encryptWithKeyring,decryptWithKeyring} from '../../runtime/secret-keyring.mjs';

const uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const customerA='00000000-0000-4000-8000-000000000100';
const minute=60_000,origin='https://portal.example.test',sessionSecret='session-secret-of-the-notification-test-000001';
const ring=createKeyring({SESSION_SECRET:sessionSecret});
let viewer=null,checks=0,clock=Date.UTC(2026,9,21,9,0,0);
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
const d=await sourceDatabase();
const body=async request=>{const text=await request.text();try{return JSON.parse(text);}catch{throw new HttpError(400,serverText('apiError.request.invalidJson'));}};
const server={db:()=>d,now:()=>clock,config:key=>key==='SITE_ORIGIN'?origin:key==='SESSION_SECRET'?sessionSecret:'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
 body,sameOrigin:()=>{},requireViewer:async()=>stamped({...viewer}),log:async()=>{},
 failure:error=>error instanceof HttpError?Response.json({error:error.message,code:error.code,messageKey:error.messageKey,params:error.params},{status:error.status}):Response.json({error:String(error?.message??error)},{status:500})};
const mfa={requireLiveSessions:async()=>{},requireMfa:async()=>{},isMfaEnabled:async()=>true,mfaSessionFence:async()=>sql`TRUE`,readMfaManagementProof:async()=>({guard:sql`TRUE`}),
 encryptSecret:(value,context)=>encryptWithKeyring(ring,value,context),decryptSecret:(value,context)=>decryptWithKeyring(ring,value,context)};
// The fake send module: records every call; `failWith` makes the next calls fail.
const sends=[];let failWith=null,sendDelay=0;
const fakeSend={sendNotification:async(target,outgoing,meta)=>{sends.push({target,outgoing,meta});if(sendDelay)await new Promise(resolve=>setTimeout(resolve,sendDelay));return failWith?{ok:false,error:failWith,attempts:3}:{ok:true,value:undefined,attempts:1};},useTransportOptions:()=>{}};
const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../identity/mfa':mfa,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,'./notify/send':fakeSend,
 '../agent/agent-protocol':{maintenanceBusy:async()=>false},'@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},
 '@/lib/management':{operations:{},safeTarget:()=>''},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},
 '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
 '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},
 '@/lib/diagnostics':{diagnosticDefinitions:{},diagnosticSecurityAccess:()=>false,isDiagnosticKind:()=>false},'@/lib/file-operations':{fileSecurityAccess:()=>false},
 '@/lib/server/devices/device-lifecycle':{removeDevice:async()=>({}),removeDevices:async()=>({}),sweepRemovedTransfers:async()=>{}},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
const load=sourceLoader();
const access=load('lib/server/identity/access.ts',imports),notifications=load('lib/server/notifications/notifications.ts',imports);
const transport=load('lib/server/notifications/notify/transport.ts',imports),message=load('lib/server/notifications/notification-message.ts',imports);
const heartbeatApi=load('app/api/heartbeat/route.ts',imports),rulesApi=load('app/api/notifications/rules/route.ts',imports),logApi=load('app/api/notifications/log/route.ts',imports);

const time=clock;
const insert=(table,row)=>insertRow(d,table,row);
async function persona(name){
 const id=uuid(),principal='local:'+id;
 await insert('local_users',{id,username:name,email:name+'@notify.test',display_name:name,auth_principal:principal,auth_email:name+'@notify.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 return stamped({id,userId:id,label:name+'@notify.test',principal});
}
async function role(name,permissions){const id=uuid();await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;}
async function grant(user,roleId,scopeType,scopeId='*'){await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${user.id},${roleId},${scopeType},${scopeId},${time},'fixture')`);}
const group=async(name,parent,customer=customerA)=>{const id=uuid();await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});return id;};
const agentKey=()=>{const jwk=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});return {jwk,pinned:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e})};};
const telemetry=(key,values={})=>({hostname:'VM',os:'Microsoft Windows Server 2025 Standard',build:'26100',manufacturer:'Microsoft',model:'VM',domain:'WORKGROUP',cores:4,memoryGb:8,cpu:10,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[{name:'Ethernet',addresses:['10.1.2.3'],mac:'00-11-22-33-44-55',speedMbps:1000}],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.6.7',mode:'Management',publicKey:{kty:'RSA',n:key.jwk.n,e:key.jwk.e},agentCapabilities:['refresh'],...values});
const agents=new Map();
async function device(name,{groupId=null,customer=customerA}={}){
 const id=uuid(),token=crypto.randomBytes(32).toString('hex'),key=agentKey();
 // A custom name: every agent here reports the computer name 'VM', and the events name the device.
 await insert('servers',{id,name,name_source:'custom',token_hash:sha(token),token_expires_at:time+365*24*60*minute,created_at:time,last_seen:clock-30_000,management:1,snapshot:JSON.stringify(telemetry(key)),agent_public_key:key.pinned,customer_id:customer});
 if(groupId)await insert('device_group_members',{server_id:id,group_id:groupId});
 agents.set(id,{token,key});return id;
}
const beat=async(id,values={})=>{
 const {token,key}=agents.get(id);
 const response=await heartbeatApi.POST(new Request('https://portal.example.test/api/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({serverId:id,snapshot:telemetry(key,values),results:[],runningJobs:[]})}));
 assert.equal(response.status,200,`heartbeat ${JSON.stringify(await response.clone().json())}`);
};
const override=(ruleId,scopeType,scopeId,settings)=>insert('alert_rule_overrides',{id:uuid(),rule_id:ruleId,scope_type:scopeType,scope_id:scopeId,enabled:1,warning:null,critical:null,level:null,duration_minutes:null,recovery:null,actor:'fixture',updated_at:time,...settings});
const events=serverId=>d.query(sql`SELECT kind,level,value,threshold,close_reason AS "closeReason",status,customer_id AS "customerId",rule_id AS "ruleId" FROM notification_events WHERE server_id=${serverId} ORDER BY occurred_at,kind`);
const channel=async(name,type,secret,config={})=>{const id=uuid();await insert('notification_channels',{id,type,name,enabled:1,language:'en',config:JSON.stringify(config),secret:await encryptWithKeyring(ring,JSON.stringify(secret),`notification-channel:${id}`),target_hint:type==='smtp'?'1 recipient via smtp.example.test:587':'https://hooks.example.test/…',revision:0,created_at:time,created_by:'fixture',updated_at:time,updated_by:'fixture'});return id;};
const rule=async(scopeType,scopeId,channelId,changes={})=>{const id=uuid();await insert('notification_rules',{id,scope_type:scopeType,scope_id:scopeId,channel_id:channelId,levels:'["info","warning","critical"]',on_open:1,on_close:1,on_escalate:1,enabled:1,revision:0,created_at:time,created_by:'fixture',updated_at:time,updated_by:'fixture',...changes});return id;};
const deliveries=channelId=>d.query(sql`SELECT d.status,d.attempts,d.next_attempt_at AS "nextAttemptAt",d.error_key AS "errorKey",e.kind FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.channel_id=${channelId} ORDER BY e.occurred_at,e.kind`);
const pendingEvent=async(serverId,alertId,changes={})=>{const id=uuid();await insert('notification_events',{id,alert_id:alertId,server_id:serverId,customer_id:customerA,kind:'open',level:'critical',rule_id:'cpu',key:'cpu',value:97,threshold:90,occurred_at:clock,status:'pending',...changes});return id;};
const rulesGet=async(as,scope)=>{viewer=as;const response=await rulesApi.GET(new Request(`https://portal.example.test/api/notifications/rules?scope=${encodeURIComponent(scope)}`));return {status:response.status,cache:response.headers.get('Cache-Control'),body:await response.json()};};
const rulesPost=async(as,payload)=>{viewer=as;const response=await rulesApi.POST(new Request('https://portal.example.test/api/notifications/rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
const logGet=async(as,query='')=>{viewer=as;const response=await logApi.GET(new Request(`https://portal.example.test/api/notifications/log?${query}`));return {status:response.status,cache:response.headers.get('Cache-Control'),body:await response.json()};};
const ruleAudits=()=>d.query(sql`SELECT action,target,scope,customer_id AS "customerId" FROM audit WHERE action LIKE 'notification-rule.%' ORDER BY id`);

try{
 // ---- Fixture ----
 await d.exec(sql`UPDATE customers SET name='Contoso' WHERE id=${customerA}`);
 const parent=await group('Berlin',null),child=await group('Berlin Web',parent);
 const owner=await persona('owner'),operator=await persona('operator'),manager=await persona('manager'),notifier=await persona('notifier'),reader=await persona('reader');
 await grant(owner,await role('Owner',['*']),'global');
 await grant(operator,await role('Operator',access.rolePermissions.operator),'global');
 await grant(manager,await role('Child manager',['view','alerts.manage']),'devicegroup',child);
 await grant(notifier,await role('Notifier',['portal.notifications.manage']),'global');
 await grant(notifier,await role('Child viewer',['view']),'devicegroup',child);
 await grant(reader,await role('Reader',access.rolePermissions.viewer),'global');

 // ---- The rules that reach one device while only the default customer exists: no customer origin, and the routing agrees ----
 const routing=load('lib/server/notifications/notification-routing.ts',imports);
 const monTop=await group('Monitor top',null),monSub=await group('Monitor sub',monTop),monitored=await device('MON01',{groupId:monSub});
 const originsOf=body=>[...new Set(body.inherited.map(item=>item.origin.type==='all'?'all':`${item.origin.type}:${item.origin.name}`))];
 // The rules as lib/server/notifications/notifications.ts loads them for the routing, and the groups of a device as it reads them.
 const routingRules=async()=>(await d.query(sql`SELECT r.id,r.scope_type,r.scope_id,r.channel_id,r.levels,r.on_open,r.on_close,r.on_escalate,r.enabled,c.enabled AS channel_enabled FROM notification_rules r JOIN notification_channels c ON c.id=r.channel_id`)).map(row=>({id:row.id,scopeType:row.scope_type,scopeId:row.scope_id,channelId:row.channel_id,levels:JSON.parse(row.levels),onOpen:Number(row.on_open)===1,onClose:Number(row.on_close)===1,onEscalate:Number(row.on_escalate)===1,enabled:Number(row.enabled)===1,channelEnabled:Number(row.channel_enabled)===1}));
 const groupIdsOf=async serverId=>(await d.query(sql`SELECT DISTINCT a.ancestor_id AS id FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id=${serverId}`)).map(row=>row.id);
 const viewChannels=(body,level,kind='open')=>[...new Set(body.inherited.filter(item=>item.enabled&&item.channel.enabled&&item.levels.includes(level)&&item.events[kind]).map(item=>item.channel.id))].sort();
 const coveredRules=(rules,multipleCustomers,groupIds)=>new Set(rules.filter(item=>routing.ruleCovers(item,{customerId:customerA,multipleCustomers,groupIds})).map(item=>item.id));
 {
  const early=await channel('Mon early','webhook',{url:'https://hooks.example.test/mon-early'});
  await rule('group',monSub,early,{levels:'["warning"]'});await rule('customer',customerA,early,{levels:'["critical"]'});
  const view=await rulesGet(owner,`device:${monitored}`);
  check([view.status,originsOf(view.body).includes(`customer:Contoso`),originsOf(view.body)[0]],[200,false,'group:Monitor sub'],'one customer: the customer rules reach nobody, so the view leaves them out');
  const rules=await routingRules(),groupIds=await groupIdsOf(monitored);
  check(new Set(view.body.inherited.map(item=>item.id)),coveredRules(rules,false,groupIds),'the same rules as ruleCovers with one customer');
  for(const level of ['info','warning','critical'])check(viewChannels(view.body,level),routing.matchingChannels({kind:'open',level,occurredAt:clock},rules,{customerId:customerA,multipleCustomers:false,groupIds}),`with one customer the view and the routing agree on ${level}`);
  await d.exec(sql`DELETE FROM notification_rules WHERE channel_id=${early}`);await d.exec(sql`DELETE FROM notification_channels WHERE id=${early}`);
 }

 // Customer B: from now on the portal has several customers.
 const customerB=uuid();await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
 const groupB=await group('B',null,customerB);
 const hookUrl='https://hooks.example.test/in/secret-path-71?key=QueryKey72',hookKey='signing-key-of-the-fixture-channel-73';
 const hook=await channel('Ops hook','webhook',{url:hookUrl,signingKey:hookKey});
 const mail=await channel('Ops mail','smtp',{password:'mail-pass-74'},{host:'smtp.example.test',port:587,tls:'starttls',from:'alerts@example.com',recipients:['ops@example.com'],username:'mailer'});
 const web=await device('WEB01',{groupId:child}),other=await device('DB-B',{groupId:groupB,customer:customerB});
 await override('cpu','global','*',{warning:80,critical:90,duration_minutes:0,recovery:0});

 // ---- Events from heartbeats ----
 clock+=minute;await beat(web,{cpu:85});
 check(await events(web),[{kind:'open',level:'warning',value:85,threshold:80,closeReason:null,status:'pending',customerId:customerA,ruleId:'cpu'}],'a heartbeat that opens an alarm writes one open event');
 clock+=minute;await beat(web,{cpu:85});
 check((await events(web)).length,1,'an unchanged heartbeat adds no event');
 clock+=minute;await beat(web,{cpu:95});
 clock+=minute;await beat(web,{cpu:93});
 check((await events(web)).map(row=>[row.kind,row.level,row.value,row.threshold]),[['open','warning',85,80],['escalate','critical',95,90]],'warning to critical is one escalation; no event for the drop of the reading');
 clock+=minute;await beat(web,{cpu:20});
 check((await events(web)).map(row=>[row.kind,row.level,row.value,row.closeReason]),[['open','warning',85,null],['escalate','critical',95,null],['close','critical',95,'recovered']],'the close carries the peak level, peak value and reason');
 const webAlert=(await d.one(sql`SELECT id FROM alerts WHERE server_id=${web}`)).id;
 check(Number((await d.one(sql`SELECT count(*) AS n FROM notification_events WHERE alert_id=${webAlert}`)).n),3,'every event names the alarm');
 // A failing event insert rolls the alarm change back; the heartbeat still answers.
 const quiet=await device('QUIET',{groupId:child});
 await createTrigger(d,'notify_events_fail','notification_events','AFTER INSERT',{message:'events-down'});
 const logged=[],error=console.error;console.error=(...parts)=>logged.push(parts.join(' '));
 try{clock+=minute;await beat(quiet,{cpu:99});}finally{console.error=error;await dropTrigger(d,'notify_events_fail','notification_events');}
 check([(await d.query(sql`SELECT id FROM alerts WHERE server_id=${quiet}`)).length,(await events(quiet)).length,logged.length],[0,0,1],'no alarm without its event, the failure is logged');
 clock+=minute;await beat(quiet,{cpu:99});
 check([(await d.query(sql`SELECT state FROM alerts WHERE server_id=${quiet}`)).map(row=>row.state),(await events(quiet)).map(row=>row.kind)],[['open'],['open']],'the next heartbeat writes both');
 // A second open event of one alarm is stopped by the partial unique index.
 await assert.rejects(pendingEvent(quiet,(await d.one(sql`SELECT id FROM alerts WHERE server_id=${quiet}`)).id),/idx_notification_events_open/);checks++;

 // ---- Dispatch: routing, follow-up events, sending ----
 await rule('all','*',hook,{levels:'["warning","critical"]'});
 clock+=minute;
 let run=await notifications.dispatchNotifications(clock,()=>{},'run-1');
 check([run.routed,run.deferred,run.sent],[2,2,2],'the opens are routed and sent; escalation and close wait for them');
 check(sends.length,1,'one message for the channel');
 check(sends[0].outgoing.entries.map(entry=>[entry.kind,entry.device.name]).sort(),[['open','QUIET'],['open','WEB01']],'both opens in one bundle');
 clock+=minute;run=await notifications.dispatchNotifications(clock,()=>{},'run-2');
 check([run.routed,run.deferred,run.sent,sends.length],[1,1,1,2],'the escalation follows to the notified channel; the close waits for it');
 check(sends[1].outgoing.entries.map(entry=>entry.kind),['escalate'],'the escalation');
 clock+=minute;run=await notifications.dispatchNotifications(clock,()=>{},'run-2b');
 check([run.routed,run.sent,sends.length,sends[2].outgoing.entries.map(entry=>entry.kind)],[1,1,3,['close']],'then the close');
 check((await deliveries(hook)).map(row=>row.status),['sent','sent','sent','sent'],'every delivery is sent');
 check(await d.one(sql`SELECT status FROM notification_events WHERE alert_id=${webAlert} AND kind='close'`),{status:'routed'},'the close is routed');
 // The lease.
 check((await notifications.runNotificationDispatch(clock)).status,'ran','the first run takes the lease');
 check((await notifications.runNotificationDispatch(clock+49_999)).status,'skipped','a second run within 50 s does not run');
 check((await notifications.runNotificationDispatch(clock+50_000)).status,'ran','after 50 s it runs again');

 // ---- Suppression ----
 const mutedAlert=uuid();
 await insert('alerts',{id:mutedAlert,server_id:web,rule_id:'memory',key:'memory',state:'open',level:'critical',peak_level:'critical',params:'{}',started_at:clock,opened_at:clock,muted_until:clock+3_600_000,muted_by:'fixture'});
 const muted=await pendingEvent(web,mutedAlert);
 const noRule=await pendingEvent(web,uuid(),{level:'info'});
 const notNotified=await pendingEvent(web,uuid(),{kind:'close',close_reason:'recovered'});
 await d.exec(sql`UPDATE customers SET maintenance_days=127,maintenance_start=0,maintenance_duration=720,maintenance_time_zone='UTC' WHERE id=${customerB}`);
 const inWindow=await pendingEvent(other,uuid(),{customer_id:customerB,occurred_at:Date.UTC(2026,9,21,11,0)});
 clock+=minute;await notifications.dispatchNotifications(clock,()=>{},'run-3');
 check(await d.query(sql`SELECT id,status,suppressed_reason AS reason FROM notification_events WHERE id IN (${muted},${noRule},${notNotified},${inWindow}) ORDER BY occurred_at,id`).then(rows=>Object.fromEntries(rows.map(row=>[row.id,[row.status,row.reason]]))),
  {[muted]:['suppressed','muted'],[noRule]:['suppressed','no-rule'],[notNotified]:['suppressed','not-notified'],[inWindow]:['suppressed','maintenance-window']},'muted, no rule, not notified and the maintenance window');
 await d.exec(sql`UPDATE alerts SET muted_until=NULL WHERE id=${mutedAlert}`);
 clock+=minute;await notifications.dispatchNotifications(clock,()=>{},'run-4');
 check((await d.one(sql`SELECT status FROM notification_events WHERE id=${muted}`)).status,'suppressed','a suppressed event is never sent later');
 check(Number((await d.one(sql`SELECT count(*) AS n FROM notification_deliveries WHERE event_id IN (${muted},${noRule},${notNotified},${inWindow})`)).n),0,'suppressed events have no deliveries');

 // ---- Two overlapping runs send each delivery once; bundling ----
 for(const user of [manager,notifier,reader,operator])await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${user.id},${time},'fixture')`);
 const bulk=[];for(let index=0;index<30;index++)bulk.push(await pendingEvent(index%2?web:quiet,uuid(),{level:index%6?'warning':'critical',rule_id:'disk-free',key:`disk-${index}`,value:5,threshold:10,occurred_at:clock+index}));
 clock+=minute;sends.length=0;sendDelay=30;
 await Promise.all([notifications.dispatchNotifications(clock,()=>{},'run-a'),notifications.dispatchNotifications(clock,()=>{},'run-b')]);
 sendDelay=0;
 check([sends.length,sends[0].outgoing.entries.length],[1,30],'overlapping runs: one call with all 30 deliveries');
 check(Number((await d.one(sql`SELECT count(*) AS n FROM notification_deliveries WHERE event_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(bulk)}::jsonb)) AND status='sent'`)).n),30,'each delivery is sent once');
 const content=message.notificationMessage(sends[0].outgoing.entries,'en',origin);
 check([content.event,content.subject,content.entries.length,content.more],['alert.bundle','30 alarm changes on 2 devices',25,5],'one bundle: 25 entries and "and 5 more"');
 check(content.entries.slice(0,5).every(entry=>entry.json.level==='critical'),true,'most severe first');
 // Message content.
 const one=message.notificationMessage([sends[0].outgoing.entries.find(entry=>entry.device.name==='WEB01')],'en',origin);
 const rendered=[message.mailText(one),message.mailHtml(one),JSON.stringify(message.webhookPayload(one,'delivery',clock,origin)),JSON.stringify(message.teamsPayload(one)),JSON.stringify(message.discordPayload(one))].join('\n');
 for(const expected of ['WEB01','Contoso','Free disk space','Value: 5 %','Threshold: 10 %',`${origin}/#device/${web}/monitoring`])assert.ok(rendered.includes(expected),`the message contains ${expected}`);
 const token=agents.get(web).token;
 for(const secret of [token,sessionSecret,hookUrl,'secret-path-71','QueryKey72',hookKey,'mail-pass-74','10.1.2.3','00-11-22-33-44-55','fixture'])assert.ok(!rendered.includes(secret),`the message never contains ${secret}`);
 checks+=16;
 check(sends[0].meta.locale,'en','the channel language');

 // ---- The Discord format ----
 {
  const {discordPayload,discordColors,discordLimits}=message;
  const mentions={parse:[]};
  const test=discordPayload(message.testMessage('en',origin,clock));
  check([Object.keys(test).sort(),test.embeds.length,Object.keys(test.embeds[0]).sort(),test.embeds[0].title,test.embeds[0].color,test.allowed_mentions],
   [['allowed_mentions','embeds'],1,['color','description','title'],'Test message from Nodiverna',0x5B5CF6,mentions],'Discord test message: one embed, no content, mentions off');
  check(test.embeds[0].description.includes('portal.example.test'),true,'the test embed names the portal');
  const single=discordPayload(one);
  check([Object.keys(single).sort(),single.embeds.length,Object.keys(single.embeds[0]).sort(),single.embeds[0].url,single.embeds[0].timestamp,single.embeds[0].title,single.embeds[0].color],
   [['allowed_mentions','embeds'],1,['color','description','timestamp','title','url'],`${origin}/#device/${web}/monitoring`,one.entries[0].occurredAt,one.entries[0].heading.replace(/([\\*_~`|>#\-[\]()])/g,'\\$1'),one.entries[0].level==='critical'?discordColors.critical:discordColors.warning],'Discord alarm: one embed with heading, link, time and level color');
  check(single.embeds[0].description.split('\n').length,one.entries[0].facts.length,'the facts are one line each');
  for(const field of ['username','avatar_url','content'])check(Object.hasOwn(single,field),false,`a single alarm has no ${field}`);
  // A bundle of 30 entries: at most 10 embeds, "and N more" for every entry not shown.
  const send=load('lib/server/notifications/notify/send.ts',imports);
  const meta={deliveryId:'delivery',time:clock,portal:origin,origin,locale:'en'};
  const bundle=JSON.parse(send.fittingMessage('discord',{kind:'alarms',entries:sends[0].outgoing.entries},meta).body);
  const shown=bundle.embeds.length;
  check([shown<=discordLimits.embeds,shown>0,bundle.content,bundle.allowed_mentions],[true,true,`30 alarm changes on 2 devices\nand ${30-shown} more`,mentions],'Discord bundle: subject and "and N more" as content, at most 10 embeds');
  const ordered=message.notificationMessage(sends[0].outgoing.entries,'en',origin,shown);
  check(bundle.embeds.map(embed=>embed.url+embed.timestamp),ordered.entries.map(entry=>entry.url+entry.occurredAt),'one embed per shown entry, in the bundle order');
  check(bundle.embeds.map(embed=>embed.color),ordered.entries.map(entry=>entry.level==='critical'?0xFF7A6E:0xE7B553),'critical and warning colors');
  // Colors per level and kind.
  const entry=(changes={})=>({eventId:uuid(),kind:'open',alertId:uuid(),level:'critical',device:{id:web,name:'WEB01'},customer:null,ruleId:'cpu',key:'cpu',value:97,threshold:90,closeReason:null,occurredAt:clock,...changes});
  const color=changes=>discordPayload(message.notificationMessage([entry(changes)],'en',origin)).embeds[0].color;
  check([color({level:'critical'}),color({level:'warning'}),color({level:'info'}),color({kind:'escalate'}),color({kind:'close',closeReason:'recovered'}),color({kind:'close',level:'warning',closeReason:'rule-off'}),color({kind:'close',level:'info',closeReason:'no-data'})],
   [0xFF7A6E,0xE7B553,0x5B5CF6,0xFF7A6E,0x4CCF96,0x4CCF96,0x4CCF96],'colors: critical, warning, info; every close is green');
  // Markdown and mentions stay literal.
  const named=discordPayload(message.notificationMessage([entry({device:{id:web,name:'*WEB*_01 @everyone'},customer:{id:customerA,name:'[Contoso](https://evil.test) ~x~',timeZone:null}})],'en',origin));
  check([named.embeds[0].title.includes('\\*WEB\\*\\_01 @everyone'),named.embeds[0].description.includes('\\*WEB\\*\\_01 @everyone'),named.embeds[0].description.includes('\\[Contoso\\]\\(https://evil.test\\) \\~x\\~'),named.allowed_mentions],[true,true,true,mentions],'device and customer names are escaped, mentions are off');
  const escapedBundle=discordPayload(message.notificationMessage([entry({device:{id:web,name:'*A*'}}),entry({device:{id:web,name:'*A*'},level:'warning'})],'en',origin));
  check(escapedBundle.content,'2 alarm changes on \\*A\\*','the bundle content is escaped');
  // Long texts are cut and end with "…".
  const long=discordPayload(message.notificationMessage([entry({device:{id:web,name:'A'.repeat(300)}})],'en',origin));
  check([long.embeds[0].title.length,long.embeds[0].title.endsWith('…'),long.embeds[0].title.startsWith('\\[Critical\\]')],[256,true,true],'a title is cut at 256 characters with "…"');
  check(message.cutText('ab\\*cd',4),'ab…','a cut never leaves half an escape');
  // Long names: the embed total stays at or below 6000, more counts the rest.
  const wide=Array.from({length:12},(_,index)=>entry({device:{id:uuid(),name:`DEVICE-${index}-${'x'.repeat(900)}`},customer:{id:customerA,name:'C'.repeat(1500),timeZone:null},occurredAt:clock+index}));
  const fitted=send.fittingMessage('discord',{kind:'alarms',entries:wide},meta),payload=JSON.parse(fitted.body);
  const total=payload.embeds.reduce((sum,embed)=>sum+embed.title.length+embed.description.length,0);
  check([total<=6000,payload.embeds.length<10,payload.embeds.length>=1,fitted.content.more,payload.content.endsWith(`and ${12-payload.embeds.length} more`)],[true,true,true,12-payload.embeds.length,true],`long names: ${payload.embeds.length} embeds with ${total} characters`);
  check(payload.embeds.every(embed=>embed.description.length<=4096&&embed.title.length<=256),true,'every embed keeps its own limits');
 }

 // ---- Retry schedule and final failure ----
 await rule('group',child,mail,{levels:'["critical"]',on_close:0,on_escalate:0});
 const retried=await pendingEvent(web,uuid(),{rule_id:'reboot-pending',key:'reboot',value:null,threshold:null});
 failWith=new transport.NotifyError('timeout');sends.length=0;
 const start=clock+minute;
 await notifications.dispatchNotifications(start,()=>{},'retry-1');clock=start;
 const mailState=async()=>(await deliveries(mail)).filter(row=>row.kind==='open').map(row=>[row.status,row.attempts,row.nextAttemptAt===null?null:Number(row.nextAttemptAt)-start,row.errorKey]);
 check(await mailState(),[['pending',1,minute,'apiError.notify.timeout']],'a failed run: pending again in 1 minute');
 await notifications.dispatchNotifications(start+30_000,()=>{},'retry-2');
 check([sends.filter(entry=>entry.target.type==='smtp').length,(await mailState())[0][1]],[1,1],'not due yet: no call');
 clock=start+minute;await notifications.dispatchNotifications(clock,()=>{},'retry-3');
 check(await mailState(),[['pending',2,minute+5*minute,'apiError.notify.timeout']],'the second failed run waits 5 minutes');
 clock=start+6*minute;await notifications.dispatchNotifications(clock,()=>{},'retry-4');
 check(await mailState(),[['failed',3,null,'apiError.notify.timeout']],'the third failed run marks it failed');
 check(sends.filter(entry=>entry.target.type==='smtp').length,3,'three runs, three calls');
 void retried;
 failWith=null;
 // A failure on one channel does not stop the others.
 const broken=await channel('Broken','teams',{url:'https://hooks.example.test/x'});
 await d.exec(sql`UPDATE notification_channels SET secret='not-a-ciphertext' WHERE id=${broken}`);
 await rule('all','*',broken);
 const both=await pendingEvent(web,uuid());
 clock+=minute;sends.length=0;await notifications.dispatchNotifications(clock,()=>{},'run-broken');
 check((await d.query(sql`SELECT channel_name AS name,status,error_key AS "errorKey" FROM notification_deliveries WHERE event_id=${both} ORDER BY channel_name`)),[{name:'Broken',status:'pending',errorKey:'apiError.notify.secretUndecryptable'},{name:'Ops hook',status:'sent',errorKey:null},{name:'Ops mail',status:'sent',errorKey:null}],'the broken channel waits for its retry, the others are sent');
 await d.exec(sql`DELETE FROM notification_channels WHERE id=${broken}`);
 // Stale sending rows: back to pending once, then failed.
 const stale=uuid(),staleEvent=await pendingEvent(web,uuid());
 await d.exec(sql`UPDATE notification_events SET status='routed' WHERE id=${staleEvent}`);
 await insert('notification_deliveries',{id:stale,event_id:staleEvent,channel_id:hook,channel_name:'Ops hook',channel_type:'webhook',target_hint:'x',status:'sending',attempts:0,claimed_by:'crashed',claimed_at:clock-11*minute,created_at:clock,recovered:0});
 clock+=minute;sends.length=0;let result=await notifications.dispatchNotifications(clock,()=>{},'run-stale');
 check([result.recovered,(await d.one(sql`SELECT status,recovered FROM notification_deliveries WHERE id=${stale}`))],[1,{status:'sent',recovered:1}],'a crashed sending row is reset once and sent');
 await d.exec(sql`UPDATE notification_deliveries SET status='sending',claimed_by='crashed',claimed_at=${clock-11*minute},sent_at=NULL WHERE id=${stale}`);
 clock+=minute;result=await notifications.dispatchNotifications(clock,()=>{},'run-stale-2');
 check([result.recovered,(await d.one(sql`SELECT status,error_key AS "errorKey" FROM notification_deliveries WHERE id=${stale}`))],[0,{status:'failed',errorKey:'apiError.notify.timeout'}],'a second time it is failed');

 // ---- Rules API: rights, boundary, audit, revision ----
 const levels=['warning','critical'],events_={open:true,close:true,escalate:false};
 const created=await rulesPost(manager,{action:'create',scope:`group:${child}`,channelId:hook,levels:['critical','warning'],events:events_,enabled:true});
 check([created.status,created.body.revision],[200,0],'a group manager creates a rule on the group');
 check((await rulesPost(manager,{action:'create',scope:`group:${child}`,channelId:hook,levels,events:events_})).body.code,'NOTIFY_RULE_EXISTS','one rule per channel and scope');
 check((await rulesPost(manager,{action:'create',scope:`group:${parent}`,channelId:hook,levels:[],events:{}})).status,403,'403 before 400 on the parent group');
 check((await rulesPost(manager,{action:'create',scope:'all',channelId:hook,levels,events:events_})).body.messageKey,'apiError.notify.allDevicesForbidden','no global right for All devices');
 check((await rulesPost(manager,{action:'create',scope:`customer:${customerA}`,channelId:hook,levels,events:events_})).body.messageKey,'apiError.notify.customerForbidden','no global right for a customer');
 check((await rulesPost(reader,{action:'create',scope:'all',channelId:hook,levels,events:events_})).status,403,'a Reader cannot change rules');
 for(const [payload,field] of [[{levels:[]},'levels'],[{levels:['urgent']},'levels'],[{events:{open:false,close:false,escalate:false}},'events'],[{channelId:uuid()},'channel'],[{channelId:'x'},'channel']])
  check((await rulesPost(operator,{action:'create',scope:`customer:${customerA}`,channelId:mail,levels,events:events_,...payload})).body.params,{field},`400 for ${field}`);
 const updated=await rulesPost(manager,{action:'update',scope:`group:${child}`,id:created.body.id,revision:0,levels:['critical'],events:{open:true,close:false,escalate:true},enabled:false});
 check([updated.status,updated.body.revision],[200,1],'update');
 check((await rulesPost(manager,{action:'update',scope:`group:${child}`,id:created.body.id,revision:0,levels,events:events_})).body.code,'NOTIFY_RULE_CHANGED','a stale revision');
 const customerRule=await rulesPost(operator,{action:'create',scope:`customer:${customerA}`,channelId:mail,levels:['info'],events:events_});
 check(customerRule.status,200,'global alerts.manage creates a customer rule');
 // The All devices level needs sight of every customer once a second customer exists.
 check((await rulesPost(operator,{action:'create',scope:'all',channelId:mail,levels,events:events_})).body.code,'NOTIFY_SCOPE_BOUNDARY','All devices needs sight of every customer');
 check((await rulesPost(operator,{action:'create',scope:`customer:${customerB}`,channelId:mail,levels,events:events_})).status,404,"customer B is outside the operator's boundary");
 check((await rulesGet(operator,`customer:${customerB}`)).status,404,'also for reading');
 check((await rulesGet(operator,`group:${groupB}`)).status,404,"customer B's group");
 const deleted=await rulesPost(operator,{action:'delete',scope:`customer:${customerA}`,id:customerRule.body.id,revision:0});
 check([deleted.status,deleted.body.revision],[200,null],'delete');
 const audits=await ruleAudits();
 check(audits.map(row=>[row.action,row.customerId]),[['notification-rule.create',customerA],['notification-rule.update',customerA],['notification-rule.create',customerA],['notification-rule.delete',customerA]],'one audit row per change with the customer');
 check(JSON.parse(audits[1].target),{id:created.body.id,scope:`group:${child}`,channel:hook,levels:['critical'],events:{open:true,close:false,escalate:true},enabled:false,old:{channel:hook,levels:['warning','critical'],events:events_,enabled:true},new:{channel:hook,levels:['critical'],events:{open:true,close:false,escalate:true},enabled:false}},'the update with old and new values');
 // GET: direct, inherited nearest first, the channels; no secrets.
 await rule('group',parent,hook,{levels:'["warning"]'});
 await rule('customer',customerA,hook,{levels:'["critical"]'});
 const view=await rulesGet(manager,`group:${child}`);
 check([view.status,view.cache,view.body.canEdit,view.body.scope.name],[200,'no-store',true,'Berlin Web'],'the group view');
 check(view.body.direct.map(item=>[item.channel.name,item.levels,item.enabled]),[['Ops hook',['critical'],false],['Ops mail',['critical'],true]],'the direct rules');
 check(view.body.inherited.map(item=>[item.origin.type,item.origin.name,item.channel.name]),[['group','Berlin','Ops hook'],['customer','Contoso','Ops hook'],['all','','Ops hook']],'inherited rules nearest first: parent group, customer, All devices');
 check(view.body.channels.map(item=>[item.name,item.type,item.enabled]),[['Ops hook','webhook',true],['Ops mail','smtp',true]],'the channel picker');
 const text=JSON.stringify(view.body);
 for(const secret of [hookUrl,'secret-path-71',hookKey,'mail-pass-74','smtp.example.test'])assert.ok(!text.includes(secret),`the rule view never contains ${secret}`);checks++;
 check([(await rulesGet(reader,`group:${child}`)).body.canEdit,(await rulesGet(reader,`group:${child}`)).body.reason],[false,'right'],'a Reader sees the rules read-only');
 // The channel picker only for editors: a viewer gets no list and no hint that other channels exist.
 const hidden=await channel('Hidden pager','teams',{url:'https://hooks.example.test/hidden-pager'});
 const readerView=await rulesGet(reader,`group:${child}`);
 check([readerView.status,readerView.body.canEdit,readerView.body.reason,readerView.body.channels],[200,false,'right',[]],'a viewer without alerts.manage gets channels: []');
 const ruleChannels=body=>[...body.direct,...body.inherited].map(item=>[item.channel.id,item.channel.name,item.channel.type,item.channel.enabled]);
 check([ruleChannels(readerView.body),readerView.body.inherited.map(item=>item.origin.type)],[ruleChannels(view.body),['group','customer','all']],'and still sees the direct and inherited rules with their channel');
 const allChannels=await d.query(sql`SELECT id,name FROM notification_channels`),shown=new Set(ruleChannels(readerView.body).map(([id])=>id)),readerText=JSON.stringify(readerView.body);
 check([allChannels.some(row=>row.id===hidden),allChannels.filter(row=>!shown.has(row.id)).filter(row=>readerText.includes(row.id)||readerText.includes(row.name)).map(row=>row.name)],[true,[]],'the answer names no channel outside its rules');
 const boundaryView=await rulesGet(operator,'all');
 check([boundaryView.status,boundaryView.body.canEdit,boundaryView.body.reason,boundaryView.body.channels,boundaryView.body.inherited],[200,false,'customer-boundary',[],[]],'outside the customer boundary on All devices: channels: []');
 check(boundaryView.body.direct.map(item=>item.channel.name),['Ops hook'],'the direct rules of All devices stay visible');
 const editorView=await rulesGet(owner,'all');
 check([editorView.body.canEdit,editorView.body.channels],[true,[{id:hidden,name:'Hidden pager',type:'teams',enabled:true},{id:hook,name:'Ops hook',type:'webhook',enabled:true},{id:mail,name:'Ops mail',type:'smtp',enabled:true}]],'an editor gets the full list');
 await d.exec(sql`DELETE FROM notification_channels WHERE id=${hidden}`);

 // ---- The rules that reach one device (scope=device:<id>, the device Monitoring area), with several customers ----
 {
  const monA=await channel('Mon A','webhook',{url:'https://hooks.example.test/mon-a'}),monB=await channel('Mon B','webhook',{url:'https://hooks.example.test/mon-b'});
  await d.exec(sql`UPDATE notification_channels SET enabled=0 WHERE id=${monB}`);
  await rule('group',monSub,monA,{levels:'["warning","critical"]'});
  await rule('group',monTop,monB,{levels:'["critical"]'});
  await rule('group',monSub,hook,{levels:'["info"]',enabled:0});
  await rule('group',groupB,monA);
  const subViewer=await persona('subviewer');await grant(subViewer,await role('Sub viewer',['view']),'devicegroup',monSub);
  await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${subViewer.id},${time},'fixture')`);
  const deviceView=await rulesGet(owner,`device:${monitored}`);
  check([deviceView.status,deviceView.cache,deviceView.body.scope,deviceView.body.direct,deviceView.body.channels,deviceView.body.canEdit,deviceView.body.reason],[200,'no-store',{type:'device',id:monitored,name:'MON01'},[],[],false,null],'the device view: no direct rules, no channels, nobody edits here');
  check(originsOf(deviceView.body),['group:Monitor sub','group:Monitor top','customer:Contoso','all'],'nearest first: the group, its parent, then the customer (several customers), then All devices');
  check(deviceView.body.inherited.filter(item=>item.origin.type==='group').map(item=>[item.origin.name,item.channel.name,item.enabled,item.channel.enabled,item.origin.visible]),[['Monitor sub','Mon A',true,true,true],['Monitor sub','Ops hook',false,true,true],['Monitor top','Mon B',true,false,true]],'a disabled rule and a rule of a disabled channel are listed with their flags');
  check(deviceView.body.inherited.some(item=>item.origin.id===groupB),false,'a group the device is not in never reaches it');
  const limited=await rulesGet(subViewer,`device:${monitored}`);
  check(limited.body.inherited.filter(item=>item.origin.type==='group').map(item=>[item.origin.name,item.origin.visible]),[['Monitor sub',true],['Monitor sub',true],['Monitor top',false]],'visible: only the groups the viewer has view on');
  check(limited.body.inherited.filter(item=>item.origin.type!=='group').every(item=>item.origin.visible),true,'customer and All devices are visible');
  // The view and the routing agree: the sending rules of the view are exactly the channels matchingChannels picks.
  const rules=await routingRules(),groupIds=await groupIdsOf(monitored);
  check(new Set(deviceView.body.inherited.map(item=>item.id)),coveredRules(rules,true,groupIds),'every rule ruleCovers matches is listed, and no other');
  for(const level of ['info','warning','critical'])for(const kind of ['open','close','escalate'])
   check(viewChannels(deviceView.body,level,kind),routing.matchingChannels({kind,level,occurredAt:clock},rules,{customerId:customerA,multipleCustomers:true,groupIds}),`the view and the routing agree on ${kind} ${level}`);
  // A device outside the boundary or unknown answers as requireDevice does; an invalid id is 400 NOTIFY_RULE_INVALID (scope).
  const outside=await rulesGet(operator,`device:${other}`),unknown=await rulesGet(owner,`device:${uuid()}`),noView=await rulesGet(subViewer,`device:${web}`);
  check([outside.status,outside.body.messageKey,'inherited' in outside.body],[404,'apiError.device.notFound',false],'a device of another customer: 404 like requireDevice, no rule data');
  check([unknown.status,unknown.body.messageKey,'inherited' in unknown.body],[404,'apiError.device.notFound',false],'an unknown device: 404');
  check([noView.status,'inherited' in noView.body],[403,false],'a device without the view right: 403 like requireDevice');
  for(const bad of ['device:x','device:','device:'+monitored+'x']){const answer=await rulesGet(owner,bad);check([answer.status,answer.body.code,answer.body.params],[400,'NOTIFY_RULE_INVALID',{field:'scope'}],`400 NOTIFY_RULE_INVALID for ${bad}`);}
  // A device has no rules of its own: a change with a device scope is refused and writes nothing.
  const before=await d.one(sql`SELECT count(*)::int AS count FROM notification_rules`);
  for(const action of [{action:'create',channelId:monA,levels,events:events_},{action:'update',id:uuid(),revision:0,levels,events:events_},{action:'delete',id:uuid(),revision:0}]){
   const answer=await rulesPost(owner,{...action,scope:`device:${monitored}`});
   check([answer.status,answer.body.code,answer.body.params],[400,'NOTIFY_RULE_INVALID',{field:'scope'}],`POST ${action.action} with a device scope: 400 (scope)`);
  }
  check((await d.one(sql`SELECT count(*)::int AS count FROM notification_rules`)).count,before.count,'no rule was written');
  // The message link opens the device's alarms in its Monitoring area.
  check(message.alarmHistoryUrl(origin,monitored),`${origin}/#device/${monitored}/monitoring`,'alarmHistoryUrl links to #device/<id>/monitoring');
  await d.exec(sql`DELETE FROM notification_rules WHERE channel_id IN (${monA},${monB}) OR scope_id=${monSub}`);await d.exec(sql`DELETE FROM notification_channels WHERE id IN (${monA},${monB})`);
 }

 // ---- Delivery log ----
 check((await logGet(reader)).status,403,'the log needs portal.notifications.manage');
 const all=await logGet(owner,'limit=100');
 check([all.status,all.cache],[200,'no-store'],'the log answers with no-store');
 check(all.body.entries.some(entry=>entry.device?.name==='DB-B'),true,'the Owner sees every device');
 const own=await logGet(notifier,'limit=100');
 check([own.status,own.body.entries.some(entry=>entry.device?.name==='DB-B'),own.body.entries.every(entry=>['WEB01','QUIET'].includes(entry.device?.name))],[200,false,true],'the log shows only devices the viewer may view');
 const suppressed=await logGet(owner,'status=suppressed&limit=100');
 check([suppressed.body.entries.every(entry=>entry.status==='suppressed'&&entry.channel===null),suppressed.body.entries.map(entry=>entry.reason).includes('maintenance-window')],[true,true],'suppressed events with their reason and no channel');
 const failedRows=await logGet(owner,'status=failed');
 const failedTriples=failedRows.body.entries.map(entry=>[entry.status,entry.errorKey,entry.attempts]);
 check([failedTriples.every(entry=>entry[0]==='failed'),failedTriples.some(entry=>entry[1]==='apiError.notify.timeout'&&entry[2]===3),failedTriples.some(entry=>entry[1]==='apiError.notify.channelChanged')],[true,true,true],'failed deliveries with their key and attempts, also of a deleted channel');
 const first=await logGet(owner,'limit=2'),second=await logGet(owner,`limit=2&before=${encodeURIComponent(first.body.next)}`);
 check([first.body.entries.length,second.body.entries.length,first.body.entries.some(entry=>second.body.entries.some(other=>other.id===entry.id))],[2,2,false],'the cursor gives the next page');
 for(const query of ['limit=0','limit=101','status=lost','before=1:x'])check((await logGet(owner,query)).status,400,`400 for ${query}`);
 const logText=JSON.stringify(all.body);
 for(const secret of [hookUrl,'secret-path-71',hookKey,'mail-pass-74'])assert.ok(!logText.includes(secret),`the log never contains ${secret}`);checks++;

 // ---- HTTP 400: failed after the first run, with its key and status ----
 await d.exec(sql`UPDATE notification_channels SET enabled=0`);
 const discord=await channel('Ops Discord','discord',{url:'https://discord.com/api/webhooks/1/token'});
 await rule('all','*',discord);
 const rejectedEvent=await pendingEvent(web,uuid());
 failWith=new transport.NotifyError('httpRejected',{params:{status:400}});sends.length=0;
 clock+=minute;await notifications.dispatchNotifications(clock,()=>{},'run-rejected');
 failWith=null;
 check(sends.map(entry=>entry.target.type),['discord'],'one call to the Discord channel');
 check(await d.query(sql`SELECT status,attempts,next_attempt_at AS "nextAttemptAt",error_key AS "errorKey",error_params AS "errorParams" FROM notification_deliveries WHERE event_id=${rejectedEvent}`),
  [{status:'failed',attempts:1,nextAttemptAt:null,errorKey:'apiError.notify.httpRejected',errorParams:'{"status":400}'}],'HTTP 400: failed after one run, no further run');
 const rejectedRow=(await logGet(owner,'status=failed')).body.entries.find(entry=>entry.eventId===rejectedEvent);
 check([rejectedRow.channel,rejectedRow.errorKey,rejectedRow.errorParams,rejectedRow.attempts],[{name:'Ops Discord',type:'discord'},'apiError.notify.httpRejected',{status:400},1],'the log row names the Discord channel, the key and the status');
 // ---- Emergency sign-ins: routed without rules, sent alone ----
 {
  const send=load('lib/server/notifications/notify/send.ts',imports);
  await d.exec(sql`UPDATE notification_channels SET enabled=0`);
  const breakGlass=await persona('breakglass');
  await insert('rbac_roles',{id:'builtin-owner',name:'Built-in Owner',description:'',permissions:'["*"]',builtin:1,created_at:time});
  const emergency=async at=>{const alarmId=uuid(),eventId=uuid();
   await insert('security_alarms',{id:alarmId,kind:'emergencySignIn',user_id:breakGlass.id,actor:'breakglass@notify.test',display_name:'Break Glass',address:'203.0.113.9',occurred_at:at});
   await insert('notification_events',{id:eventId,kind:'emergency',level:'critical',security_alarm_id:alarmId,occurred_at:at,status:'pending'});return eventId;};
  const nobody=await emergency(clock);
  clock+=minute;sends.length=0;await notifications.dispatchNotifications(clock,()=>{},'run-emergency-none');
  check([await d.one(sql`SELECT status,suppressed_reason AS reason FROM notification_events WHERE id=${nobody}`),sends.length],[{status:'suppressed',reason:'no-recipient'},0],'no enabled channel: the emergency event is suppressed with no-recipient');
  // The Owner addresses: direct global Owners (custom '*' roles too, local and Entra), active, not empty, lower-cased, de-duplicated, sorted, at most maxRecipients.
  const twin=await persona('twin');await d.exec(sql`UPDATE local_users SET email=' OWNER@Notify.test ' WHERE id=${twin.id}`);await grant(twin,'builtin-owner','global');
  const entraId=uuid();
  await insert('local_users',{id:entraId,username:'entra-owner',email:'a-entra@notify.test',display_name:'Entra Owner',auth_principal:'entra:tenant-77:object-77',auth_email:'a-entra@notify.test',status:'active',auth_version:1,created_at:time,updated_at:time,identity_source:'entra',entra_tenant_id:'tenant-77',entra_object_id:'object-77'});
  await grant({id:entraId},'builtin-owner','global');
  const locked=await persona('b-locked');await d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${locked.id}`);await grant(locked,'builtin-owner','global');
  const blank=await persona('blank');await d.exec(sql`UPDATE local_users SET email='' WHERE id=${blank.id}`);await grant(blank,'builtin-owner','global');
  const grouped=await persona('c-grouped');await grant(grouped,'builtin-owner','devicegroup',child);
  for(let index=0;index<20;index++)await grant(await persona(`zz-${String(index).padStart(2,'0')}`),'builtin-owner','global');
  const expected=['a-entra@notify.test','owner@notify.test',...Array.from({length:18},(_,index)=>`zz-${String(index).padStart(2,'0')}@notify.test`)];
  // Channels: the oldest enabled email channel; chat channels only with an enabled All devices rule for critical.
  const later=await channel('Later mail','smtp',{password:'mail-pass-75'},{host:'smtp.example.test',port:587,tls:'starttls',from:'alerts@example.com',recipients:['later@example.com'],username:'mailer'});
  await d.exec(sql`UPDATE notification_channels SET created_at=${time+1} WHERE id=${later}`);
  const groupTeams=await channel('Group teams','teams',{url:'https://hooks.example.test/group'});await rule('group',child,groupTeams,{levels:'["critical"]'});
  const warnTeams=await channel('Warn teams','teams',{url:'https://hooks.example.test/warn'});await rule('all','*',warnTeams,{levels:'["warning"]'});
  const offTeams=await channel('Off teams','teams',{url:'https://hooks.example.test/off'});await rule('all','*',offTeams,{levels:'["critical"]',enabled:0});
  await d.exec(sql`UPDATE notification_channels SET enabled=1 WHERE id IN (${mail},${hook},${discord})`);
  // A mute of every alarm and maintenance windows of every customer do not touch it.
  await d.exec(sql`UPDATE alerts SET muted_until=${clock+86_400_000},muted_by='fixture'`);
  await d.exec(sql`UPDATE customers SET maintenance_days=127,maintenance_start=0,maintenance_duration=720,maintenance_time_zone='UTC'`);
  const signedIn=await emergency(clock+1);
  const alarmEvent=await pendingEvent(web,uuid(),{customer_id:null,occurred_at:clock+2});
  clock+=minute;sends.length=0;await notifications.dispatchNotifications(clock,()=>{},'run-emergency');
  check(await d.one(sql`SELECT status FROM notification_events WHERE id=${signedIn}`),{status:'routed'},'the emergency event is routed');
  check(await d.query(sql`SELECT channel_name AS name,status,recipients FROM notification_deliveries WHERE event_id=${signedIn} ORDER BY channel_name`),
   [{name:'Ops Discord',status:'sent',recipients:null},{name:'Ops hook',status:'sent',recipients:null},{name:'Ops mail',status:'sent',recipients:JSON.stringify(expected)}],'the oldest email channel with the Owner addresses, Discord and the webhook with an All devices critical rule; no other channel');
  const alone=sends.filter(entry=>entry.outgoing.kind==='emergency');
  check(alone.map(entry=>entry.target.type).sort(),['discord','smtp','webhook'],'one message per channel');
  check(alone.find(entry=>entry.target.type==='smtp').target.config.recipients,expected,"the email goes to the Owner addresses, not to the channel's own recipients");
  check(alone.map(entry=>entry.outgoing.signIn),Array(3).fill({account:'Break Glass',occurredAt:clock-minute+1,address:'203.0.113.9'}),'the sign-in: display name, time and address');
  check(sends.filter(entry=>entry.outgoing.kind==='alarms').map(entry=>[entry.target.type,entry.outgoing.entries.map(item=>item.eventId)]).sort(),['discord','smtp','teams','webhook'].map(type=>[type,[alarmEvent]]),'the alarm of the same run goes out in its own message, without the emergency');
  check(sends.find(entry=>entry.outgoing.kind==='alarms'&&entry.target.type==='smtp').target.config.recipients,['ops@example.com'],'the alarm email keeps the channel recipients');
  await d.exec(sql`UPDATE alerts SET muted_until=NULL,muted_by=NULL`);
  await d.exec(sql`UPDATE customers SET maintenance_days=NULL,maintenance_start=NULL,maintenance_duration=NULL,maintenance_time_zone=NULL`);
  // A retry keeps the recipients stored at routing.
  const retriedEmergency=await emergency(clock+1);
  failWith=new transport.NotifyError('timeout');clock+=minute;sends.length=0;
  await notifications.dispatchNotifications(clock,()=>{},'run-emergency-retry-1');
  failWith=null;
  check(await d.query(sql`SELECT channel_name AS name,status,attempts,error_key AS "errorKey" FROM notification_deliveries WHERE event_id=${retriedEmergency} ORDER BY channel_name`),
   ['Ops Discord','Ops hook','Ops mail'].map(name=>({name,status:'pending',attempts:1,errorKey:'apiError.notify.timeout'})),'a failed emergency delivery waits for its retry like any delivery');
  const newcomer=await persona('aa-newcomer');await grant(newcomer,'builtin-owner','global');
  clock+=minute;sends.length=0;await notifications.dispatchNotifications(clock,()=>{},'run-emergency-retry-2');
  check([sends.find(entry=>entry.outgoing.kind==='emergency'&&entry.target.type==='smtp')?.target.config.recipients,(await d.one(sql`SELECT status,attempts FROM notification_deliveries WHERE event_id=${retriedEmergency} AND channel_id=${mail}`))],[expected,{status:'sent',attempts:2}],'the retry sends to the stored recipients');
  // The delivery log: its own event kind and no device, also for a viewer who sees only some devices.
  const emergencyRows=(await logGet(owner,'limit=100')).body.entries.filter(entry=>entry.event==='emergency');
  check([emergencyRows.length,emergencyRows.every(entry=>entry.device===null&&entry.level==='critical'),emergencyRows.find(entry=>entry.eventId===nobody)?.reason],[7,true,'no-recipient'],'the log lists every emergency delivery and the suppressed event');
  check((await logGet(notifier,'limit=100')).body.entries.filter(entry=>entry.event==='emergency').length,7,'a viewer of some devices sees them too');
  check(/Break Glass|203\.0\.113\.9/.test(JSON.stringify(emergencyRows)),false,'the log names no account and no address');
  // The message in both languages and all four channel types.
  const signIn={account:'Break Glass',occurredAt:Date.UTC(2026,9,21,12,30,0),address:'203.0.113.9'};
  const texts={en:['Emergency access was used in Nodiverna','Account: Break Glass','Time: 2026-10-21T12:30:00.000Z','Address: 203.0.113.9','change the password of the emergency access'],
   de:['Der Notfallzugang wurde in Nodiverna benutzt','Konto: Break Glass','Zeit: 2026-10-21T12:30:00.000Z','Adresse: 203.0.113.9','ändere das Passwort des Notfallzugangs']};
  // Discord and Teams escape markdown characters; the check reads the literal text.
  const literal=text=>text.replace(/\\([\\`*_[\]()#+\-!>~|])/g,'$1');
  for(const locale of ['en','de'])for(const type of ['smtp','teams','discord','webhook']){
   const rendered=send.fittingMessage(type,{kind:'emergency',signIn},{deliveryId:'delivery',time:clock,portal:'Nodiverna',origin,locale});
   const body=type==='smtp'?rendered.mail.text+rendered.mail.html:type==='discord'?literal(JSON.parse(rendered.body).embeds.map(embed=>[embed.title,embed.description,embed.url].join('\n')).join('\n')):type==='teams'?literal(JSON.parse(rendered.body).attachments[0].content.body.map(block=>block.text??block.actions[0].url).join('\n')):rendered.body;
   // The webhook JSON carries the heading and the fields; the other formats the fact lines.
   for(const expectedText of [...type==='webhook'?[texts[locale][0],'"account":"Break Glass"','"address":"203.0.113.9"','"occurredAt":"2026-10-21T12:30:00.000Z"','"level":"critical"']:texts[locale],`${origin}/#settings/audit`])assert.ok(body.includes(expectedText),`${locale} ${type}: ${expectedText}`);
   for(const secret of [sessionSecret,'mail-pass-74','mail-pass-75',hookKey,breakGlass.id,'breakglass@notify.test','local:'])assert.ok(!body.includes(secret),`${locale} ${type} never contains ${secret}`);
   check([rendered.content.event,rendered.content.entries.length,rendered.content.entries[0].level,rendered.content.more],['emergency',1,'critical',0],`${locale} ${type}: one critical entry`);
   checks+=2;
  }
 }
}finally{await d.close();}

console.log(`PASS notifications (${checks} checks): events in the alarm transaction, no event without change, dispatcher with lease, follow-ups after the open, suppression, overlapping runs, bundling, message content without secrets, retries and final failure, the Discord format and limits, HTTP 400 failed after one run, one broken channel, stale sending, rules API rights and boundary, the rules that reach a device (order, several customers, flags, visibility, boundary, no device writes, same channels as the routing), channel picker only for editors, audit, revision, delivery log with visibility, filters and cursor, emergency sign-ins routed to the Owners and sent alone.`);
