// The integrity events of agent 4.18.0 on PostgreSQL (lib/server/agent/agent-integrity.ts,
// lib/alert-rules.ts, docs/alert-rules.md): the strict route schema with its
// bounds, the 16 KiB limit, the clamp of a future time, the 7-day drop and the
// caps of 100 stop events and 100 tamper events per 24 hours (two separate
// pools that cannot crowd each other out); a removed device is refused and a repeated event ID
// gives no second row; one audit row per new event that is not planned; the
// update guard; syncDeviceAlerts opens the alarms; every key of the three rules
// with the 24-hour window edges, the "after the last Heartbeat" rule, snapshot
// start types and findings, silence for older agents and no transitions during
// an update; consoleAgentIntegrity in one statement and no agentIntegrity in the
// console row; the issue texts in English and German and the device area; the
// sample warning of SRV-FILE01; and the 90-day retention of the daily maintenance.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {HttpError} from '../support/http-error.mjs';
import {serverText} from '../support/server-text.mjs';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {runMaintenance} from '../../runtime/maintenance.mjs';
const rules=await import('../../lib/alert-rules.ts');
const {alertTransitions}=await import('../../lib/server/devices/alert-state.ts');
const {alarmTarget}=await import('../../ui/base/health-score.ts');
const {issueText}=await import('../../ui/base/ui-device.ts');
const {demoData}=await import('../../ui/shell/demo.ts');
const contract=await import('../../lib/agent-integrity-contract.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const minute=60_000,hour=60*minute,day=24*hour;

// ---- The evaluation (pure) -------------------------------------------------------------------------
{
 const now=Date.UTC(2026,10,9,12),settings=rules.defaultAlertSettings();
 const integrityRules=['agent-stopped','agent-removed','agent-protection-changed'];
 let serial=0;
 const event=(kind,age,extra={})=>({id:'e'+(++serial),kind,service:null,target:null,startType:null,reason:null,user:null,finding:null,repaired:null,occurredAt:now-age,receivedAt:now-age,...extra});
 const snapshot=(agentIntegrity)=>({cpu:5,memory:5,disks:[],...(agentIntegrity?{agentIntegrity}:{})});
 const issues=({events=[],integrity=null,lastSeen=now-10_000,own=settings,maintenance}={})=>rules.evaluateAlertRules({snapshot:snapshot(integrity),lastSeen,agentIntegrity:events.length?{events}:undefined,maintenance},own,now).filter(issue=>integrityRules.includes(issue.ruleId)).map(({key,ruleId,level,params})=>({key,ruleId,level,params}));
 check(issues(),[],'an older agent without events and without agentIntegrity is silent');
 check(issues({integrity:{checkedAt:new Date(now).toISOString(),services:[{service:'broker',startType:'delayed-auto'},{service:'worker',startType:'auto'}],findings:[]}}),[],'a clean snapshot is silent');
 // agent-stopped: the 24-hour window.
 for(const kind of ['service-stopped','service-ended','service-hung','service-restarted','broker-unresponsive']){
  const service=kind==='broker-unresponsive'?'broker':'worker';
  check(issues({events:[event(kind,day-1,{service})]}),[{key:'agent-stopped',ruleId:'agent-stopped',level:'warning',params:{kind,service,at:now-day+1}}],`${kind} 24 h - 1 ms ago fires`);
 }
 check(issues({events:[event('service-ended',day+1,{service:'worker'})]}),[],'service-ended 24 h + 1 ms ago is silent');
 check(issues({events:[event('service-stopped',day+1,{service:'broker'})],lastSeen:now-day-2}),[{key:'agent-stopped',ruleId:'agent-stopped',level:'warning',params:{kind:'service-stopped',service:'broker',at:now-day-1}}],'service-stopped 24 h + 1 ms ago fires while no Heartbeat came since (the cause lasts)');
 check(issues({events:[event('broker-unresponsive',3*day,{service:'broker'})],lastSeen:now-4*day}).map(item=>item.params.kind),['broker-unresponsive'],'broker-unresponsive after the last Heartbeat');
 check(issues({events:[event('service-stopped',day+1,{service:'broker'})],lastSeen:now-day}),[],'a Heartbeat after the old stop: silent');
 check(issues({events:[event('service-ended',2*hour,{service:'worker'}),event('service-restarted',hour,{service:'worker'})]})[0].params,{kind:'service-restarted',service:'worker',at:now-hour},'the params of the newest event');
 // agent-stopped: the start type of each service.
 const types=(broker,worker)=>({checkedAt:new Date(now-minute).toISOString(),services:[{service:'broker',startType:broker},{service:'worker',startType:worker}],findings:[]});
 check(issues({integrity:types('delayed-auto','disabled')}),[{key:'agent-start-type-worker',ruleId:'agent-stopped',level:'warning',params:{service:'worker',startType:'disabled'}}],'the snapshot reports the worker disabled');
 check(issues({integrity:types('manual','unknown')}).map(item=>[item.key,item.params.startType]),[['agent-start-type-broker','manual'],['agent-start-type-worker','unknown']],'manual and unknown');
 check(issues({integrity:types('auto','delayed-auto')}),[],'auto and delayed-auto are silent');
 check(issues({events:[event('start-type-changed',2*hour,{service:'worker',startType:'disabled'})],lastSeen:now-3*hour}).map(item=>[item.key,item.params.startType]),[['agent-start-type-worker','disabled']],'a start-type-changed event after the last Heartbeat');
 check(issues({events:[event('start-type-changed',2*hour,{service:'worker',startType:'disabled'})],integrity:types('delayed-auto','delayed-auto'),lastSeen:now-minute}),[],'set back: the newer Heartbeat reports delayed-auto');
 // agent-removed.
 check(issues({events:[event('agent-removed',day-1,{reason:'local-uninstall',user:'CONTOSO\\admin'})]}),[{key:'agent-removed',ruleId:'agent-removed',level:'critical',params:{reason:'local-uninstall',at:now-day+1,user:'CONTOSO\\admin'}}],'a local uninstall with its user');
 check(issues({events:[event('agent-removed',3*day,{reason:'service-deleted'})],lastSeen:now-4*day}).map(item=>item.params),[{reason:'service-deleted',at:now-3*day}],'a deleted service, no Heartbeat since');
 check(issues({events:[event('agent-removed',day+1,{reason:'service-deleted'})],lastSeen:now-minute}),[],'reinstalled: a Heartbeat after the old removal');
 // agent-protection-changed.
 check(issues({events:[event('protection-changed',day-1,{service:'worker',target:'service-dacl',repaired:true,finding:'ace S-1-5-11'})]}),[{key:'agent-protection-service-dacl-worker',ruleId:'agent-protection-changed',level:'critical',params:{target:'service-dacl',at:now-day+1,repaired:'true',service:'worker'}}],'a repaired DACL change of 24 h - 1 ms ago');
 check(issues({events:[event('protection-changed',day+1,{target:'folder-agent',repaired:true})]}),[],'24 h + 1 ms ago is silent');
 const findings={checkedAt:new Date(now-5*minute).toISOString(),services:[],findings:[{target:'folder-agent'},{target:'service-recovery',service:'broker'}]};
 check(issues({integrity:findings}),[{key:'agent-protection-folder-agent-folder',ruleId:'agent-protection-changed',level:'critical',params:{target:'folder-agent',at:now-5*minute,repaired:'false'}},{key:'agent-protection-service-recovery-broker',ruleId:'agent-protection-changed',level:'critical',params:{target:'service-recovery',at:now-5*minute,repaired:'false',service:'broker'}}],'open snapshot findings: one issue per target, not repaired');
 check(issues({events:[event('protection-changed',hour,{target:'folder-agent',repaired:true})],integrity:findings}).find(item=>item.key==='agent-protection-folder-agent-folder').params.repaired,'false','a finding that lasts wins over the repaired event');
 // Settings and the alarm state.
 const off={...settings,'agent-stopped':{...settings['agent-stopped'],enabled:false},'agent-removed':{...settings['agent-removed'],level:'warning'}};
 check(issues({events:[event('service-ended',hour,{service:'worker'}),event('agent-removed',hour,{reason:'service-deleted'})],own:off}).map(item=>[item.ruleId,item.level]),[['agent-removed','warning']],'a turned-off rule is silent; the level follows the settings');
 const fired=rules.evaluateAlertRules({snapshot:snapshot(null),lastSeen:now-10_000,agentIntegrity:{events:[event('service-ended',hour,{service:'worker'})]}},settings,now);
 check(alertTransitions({server:{snapshot:snapshot(null),lastSeen:now-10_000,maintenance:{state:'updating',version:'4.18.0',notBefore:0}},alerts:[],issues:fired,readings:[],settings,now}),{inserts:[],updates:[],closes:[],deletes:[]},'no transitions while an agent update runs');
 check(alertTransitions({server:{snapshot:snapshot(null),lastSeen:now-10_000},alerts:[],issues:fired,readings:[],settings,now}).inserts.map(row=>[row.ruleId,row.key,row.state]),[['agent-stopped','agent-stopped','open']],'otherwise the alarm opens at once');
 check(rules.evaluateAlertRules({snapshot:null,lastSeen:null,agentIntegrity:{events:[event('agent-removed',hour,{reason:'service-deleted'})]}},settings,now).map(item=>item.ruleId),['agent-removed'],'the events count without a snapshot');
 check(contract.AGENT_INTEGRITY_WINDOW_MS,day,'the window is 24 hours');

 // ---- Texts and area ----
 const en=(ruleId,params)=>issueText({ruleId,params},'en',now),de=(ruleId,params)=>issueText({ruleId,params},'de',now);
 const at=Date.UTC(2026,10,9,8,30);
 const texts=[
  ['service-stopped','Agent stopped on the device','Someone stopped the worker service (ServerDeskWorker) on','Agent auf dem Gerät gestoppt','Jemand hat den Workerdienst (ServerDeskWorker) am'],
  ['service-ended','Agent ended unexpectedly','The worker service (ServerDeskWorker) ended on','Agent unerwartet beendet','Der Workerdienst (ServerDeskWorker) wurde am'],
  ['service-hung','Agent worker did not respond','The worker service (ServerDeskWorker) did not respond for 3 minutes.','Agent-Worker reagierte nicht','Der Workerdienst (ServerDeskWorker) hat 3 Minuten nicht reagiert.'],
  ['service-restarted','Agent worker restarted','The worker service (ServerDeskWorker) was stopped.','Agent-Worker neu gestartet','Der Workerdienst (ServerDeskWorker) war gestoppt.'],
 ];
 for(const [kind,title,detail,titleDe,detailDe] of texts){
  const english=en('agent-stopped',{kind,service:'worker',at}),german=de('agent-stopped',{kind,service:'worker',at});
  check([english.title,english.detail.startsWith(detail),german.title,german.detail.startsWith(detailDe)],[title,true,titleDe,true],`${kind} in English and German`);
 }
 const unresponsive=en('agent-stopped',{kind:'broker-unresponsive',service:'broker',at});
 check([unresponsive.title,unresponsive.detail.startsWith('The broker service (ServerDeskAgent) has not answered since '),de('agent-stopped',{kind:'broker-unresponsive',service:'broker',at}).title],['Agent broker does not respond',true,'Agent-Broker reagiert nicht'],'broker-unresponsive');
 for(const [startType,english,german] of [['manual','Manual','Manuell'],['disabled','Disabled','Deaktiviert'],['unknown','Unknown','Unbekannt']]){
  check([en('agent-stopped',{service:'worker',startType}).detail,de('agent-stopped',{service:'worker',startType}).detail],[`The worker service (ServerDeskWorker) has the start type ${english}. Set it to Automatic (Delayed Start) again.`,`Der Workerdienst (ServerDeskWorker) hat den Starttyp ${german}. Stelle ihn wieder auf Automatisch (Verzögerter Start).`],`start type ${startType}`);
 }
 check(en('agent-stopped',{service:'broker',startType:'disabled'}).title,'Agent no longer starts automatically','the start type title');
 const local=en('agent-removed',{reason:'local-uninstall',at,user:'CONTOSO\\admin'}),deleted=de('agent-removed',{reason:'service-deleted',at});
 check([local.title,local.detail.startsWith('CONTOSO\\admin uninstalled the agent on the device on '),local.detail.endsWith('Remove the device in Nodiverna, or install the agent again.'),deleted.title,deleted.detail.startsWith('Der Agentdienst wurde am ')],['Agent removed outside the portal',true,true,'Agent außerhalb des Portals entfernt',true],'agent-removed: local uninstall and deleted service');
 const targets=[['service-dacl','broker','broker service permissions','Berechtigungen des Brokerdienstes'],['service-dacl','worker','worker service permissions','Berechtigungen des Workerdienstes'],['service-sid','broker','broker service SID','Dienst-SID des Brokerdienstes'],['service-sid','worker','worker service SID','Dienst-SID des Workerdienstes'],
  ['service-recovery','broker','broker service recovery','Wiederherstellung des Brokerdienstes'],['service-recovery','worker','worker service recovery','Wiederherstellung des Workerdienstes'],['folder-agent',null,'agent folder permissions','Berechtigungen des Agentordners'],['folder-plugins',null,'extension folder permissions','Berechtigungen des Erweiterungsordners'],['folder-staging',null,'update folder permissions','Berechtigungen des Updateordners']];
 for(const [target,service,english,german] of targets){
  const params={target,at,repaired:'true',...(service?{service}:{})};
  check([en('agent-protection-changed',params).title,de('agent-protection-changed',params).title],[`Agent protection changed: ${english}`,`Agentschutz geändert: ${german}`],`target ${target} ${service??''}`);
 }
 check([en('agent-protection-changed',{target:'folder-agent',at,repaired:'true'}).detail.endsWith('and restored by the agent.'),en('agent-protection-changed',{target:'folder-agent',at,repaired:'false'}).detail.endsWith('Install the agent again with --install.'),de('agent-protection-changed',{target:'folder-agent',at,repaired:'false'}).detail.endsWith('Installiere den Agent erneut mit --install.')],[true,true,true],'repaired and open');
 for(const ruleId of integrityRules)check(alarmTarget(ruleId,{}),{section:'overview'},`${ruleId} opens the Overview`);
 // The sample device SRV-FILE01: the watchdog restarted its worker 40 minutes ago.
 const file=demoData().servers.find(server=>server.name==='SRV-FILE01');
 const sample=file.issues.filter(issue=>integrityRules.includes(issue.ruleId));
 check(sample.map(issue=>[issue.ruleId,issue.key,issue.level,issue.params.kind,issue.params.service]),[['agent-stopped','agent-stopped','warning','service-restarted','worker']],'SRV-FILE01 shows the agent-stopped warning');
 check('agentIntegrity' in file,false,'the sample row carries no integrity events');
 check(demoData().servers.filter(server=>server.name!=='SRV-FILE01').flatMap(server=>server.issues).filter(issue=>integrityRules.includes(issue.ruleId)),[],'no other sample device has an agent alarm');
}

// ---- The route, the audit, the update guard and the alarms on PostgreSQL ------------------------------
const d=await sourceDatabase();
try{
 let clock=Date.UTC(2026,10,9,12);
 const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const counted={on:false,statements:0};
 const db=hookDatabase(d,{statement:()=>{if(counted.on)counted.statements++;}});
 const limits=[];
 const body=async(request,limit)=>{limits.push(limit);const text=await request.text();if(Buffer.byteLength(text)>limit)throw new HttpError(413,serverText('apiError.request.tooLarge'));return JSON.parse(text);};
 const stub={db:()=>db,now:()=>clock,config:()=>'',HttpError,body,hash:async value=>sha(value),random:()=>crypto.randomBytes(32).toString('hex'),guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)};
 const load=sourceLoader(),imports={'../context':stub,'./context':stub,'@/lib/server/context':stub};
 const integrity=load('lib/server/agent/agent-integrity.ts',imports),projection=load('lib/server/devices/device-projection.ts',imports);
 const errors=[],logError=console.error;console.error=(...args)=>{errors.push(args.join(' '));};
 const device=async name=>{
  const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
  await insertRow(d,'servers',{id,name,token_hash:sha(token),token_expires_at:clock+30*day,created_at:clock-30*day,last_seen:clock-10_000,management:1,snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.18.0',mode:'Management',cpu:5,memory:5,disks:[],processes:[],agentCapabilities:['agent-integrity']})});
  return {id,token,name};
 };
 const post=async(target,payload,raw)=>{
  try{const response=await integrity.ingestAgentIntegrity(new Request('https://portal.test/api/agent/integrity',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+target.token},body:raw??JSON.stringify(payload)}));return {status:response.status,body:await response.json(),cache:response.headers.get('Cache-Control')};}
  catch(error){if(!(error instanceof HttpError))throw error;return {status:error.status,key:error.messageKey};}
 };
 const item=(kind,extra={})=>({id:crypto.randomUUID(),kind,at:new Date(clock).toISOString(),...extra});
 const report=(target,events)=>({serverId:target.id,events});
 const rows=id=>d.query(sql`SELECT event_id AS "eventId",kind,service,target,start_type AS "startType",reason,user_name AS "user",finding,repaired,planned,occurred_at AS "occurredAt",received_at AS "receivedAt" FROM agent_integrity_events WHERE server_id=${id} ORDER BY received_at,occurred_at,event_id`);
 const audits=id=>d.query(sql`SELECT actor,action,target FROM audit WHERE server_id=${id} AND action LIKE 'agent.integrity.%' ORDER BY at,action`);

 // ---- The schema ----
 const schema=integrity.agentIntegrityReport,id=crypto.randomUUID(),valid={serverId:id,events:[item('protection-changed',{service:'worker',target:'service-dacl',repaired:true,finding:'ace S-1-5-11'})]};
 check(schema.safeParse(valid).success,true,'a valid report');
 for(const [label,value] of [
  ['an unknown key',{...valid,extra:1}],['an unknown event key',{...valid,events:[{...valid.events[0],color:'red'}]}],['no event',{...valid,events:[]}],['21 events',{...valid,events:Array.from({length:21},()=>item('service-ended',{service:'worker'}))}],
  ['an unknown kind',{...valid,events:[item('service-paused')]}],['an unknown target',{...valid,events:[item('protection-changed',{target:'registry'})]}],['an unknown service',{...valid,events:[item('service-ended',{service:'updater'})]}],
  ['the start type auto',{...valid,events:[item('start-type-changed',{service:'worker',startType:'auto'})]}],['an unknown reason',{...valid,events:[item('agent-removed',{reason:'portal'})]}],
  ['a finding of 121 characters',{...valid,events:[item('protection-changed',{target:'folder-agent',finding:'x'.repeat(121)})]}],['a control character',{...valid,events:[item('protection-changed',{target:'folder-agent',finding:'a\nb'})]}],
  ['a user of 257 characters',{...valid,events:[item('agent-removed',{reason:'local-uninstall',user:'u'.repeat(257)})]}],['an event ID that is no GUID',{...valid,events:[{...valid.events[0],id:'1'}]}],['a time that is no time',{...valid,events:[{...valid.events[0],at:'today'}]}],['a serverId that is no GUID',{...valid,serverId:'x'}],
 ])check(schema.safeParse(value).success,false,'the schema refuses '+label);
 check(schema.safeParse({...valid,events:Array.from({length:20},()=>item('service-ended',{service:'worker'}))}).success,true,'20 events');

 // ---- Authentication, size and the body ----
 const a=await device('SRV-A'),b=await device('SRV-B'),c=await device('SRV-C'),removed=await device('SRV-REMOVED');
 check(await post(a,null,JSON.stringify({...report(a,[item('service-ended',{service:'worker'})]),padding:'x'.repeat(17_000)})),{status:413,key:'apiError.request.tooLarge'},'a body above 16 KiB');
 check(limits.at(-1),16384,'the limit is 16 KiB');
 check(await post(a,{serverId:a.id,events:[]}),{status:400,key:'apiError.agentIntegrity.invalid'},'an invalid report');
 check(await post(a,report(b,[item('service-ended',{service:'worker'})])),{status:403,key:'apiError.agent.notApproved'},'the body names another device');
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${removed.id}`);
 check(await post(removed,report(removed,[item('service-ended',{service:'worker'})])),{status:403,key:'apiError.agent.notApproved'},'a removed device is refused');

 // ---- Store, audit, repeat ----
 const stopped=item('service-stopped',{service:'worker'});
 const first=await post(a,report(a,[stopped]));
 check([first.status,first.body,first.cache],[200,{ok:true,accepted:[stopped.id]},'no-store'],'the event is accepted');
 check(await rows(a.id),[{eventId:stopped.id,kind:'service-stopped',service:'worker',target:null,startType:null,reason:null,user:null,finding:null,repaired:null,planned:false,occurredAt:clock,receivedAt:clock}],'one row');
 check(await audits(a.id),[{actor:'Agent',action:'agent.integrity.service-stopped',target:`SRV-A / ${a.id} / worker`}],'one audit row');
 const open=id=>d.query(sql`SELECT rule_id AS "ruleId",key,state,level FROM alerts WHERE server_id=${id} AND state<>'closed' ORDER BY rule_id,key`);
 check(await open(a.id),[{ruleId:'agent-stopped',key:'agent-stopped',state:'open',level:'warning'}],'syncDeviceAlerts opens the agent-stopped alarm');
 clock+=minute;
 check((await post(a,report(a,[stopped]))).body.accepted,[stopped.id],'a repeated ID is accepted again');
 check([(await rows(a.id)).length,(await audits(a.id)).length],[1,1],'without a second row or audit row');
 // Every field, the audit target per kind.
 clock+=minute;
 const protection=item('protection-changed',{service:'worker',target:'service-dacl',repaired:true,finding:'ace S-1-5-11'}),startType=item('start-type-changed',{service:'broker',startType:'disabled'}),local=item('agent-removed',{reason:'local-uninstall',user:'CONTOSO\\admin'}),folder=item('protection-changed',{target:'folder-agent',repaired:false,finding:'ServerDesk ace S-1-5-32-545'});
 check((await post(a,report(a,[protection,startType,local,folder]))).body.accepted,[protection.id,startType.id,local.id,folder.id],'four events');
 check((await audits(a.id)).slice(1).map(row=>row.target).sort(),[`SRV-A / ${a.id} / broker / disabled`,`SRV-A / ${a.id} / folder-agent / ServerDesk ace S-1-5-32-545`,`SRV-A / ${a.id} / local-uninstall`,`SRV-A / ${a.id} / worker / ace S-1-5-11`].sort(),'the audit targets: service or target, then reason, start type or finding');
 check((await rows(a.id)).find(row=>row.eventId===local.id).user,'CONTOSO\\admin','the user is stored');
 check((await open(a.id)).map(row=>[row.ruleId,row.key,row.level]),[['agent-protection-changed','agent-protection-folder-agent-folder','critical'],['agent-protection-changed','agent-protection-service-dacl-worker','critical'],['agent-removed','agent-removed','critical'],['agent-stopped','agent-start-type-broker','warning'],['agent-stopped','agent-stopped','warning']],'the alarms of every rule');
 // Times: a future time is clamped, an old one is acknowledged without a row.
 const ahead=item('service-ended',{service:'worker',at:new Date(clock+6*minute).toISOString()}),near=item('service-ended',{service:'worker',at:new Date(clock+4*minute).toISOString()}),old=item('service-ended',{service:'worker',at:new Date(clock-7*day-minute).toISOString()});
 check((await post(b,report(b,[ahead,near,old]))).body.accepted,[ahead.id,near.id,old.id],'all three are acknowledged');
 check((await rows(b.id)).map(row=>[row.eventId,row.occurredAt]).sort(),[[ahead.id,clock],[near.id,clock+4*minute]].sort(),'more than 5 minutes ahead: the receive time; 4 minutes ahead kept; older than 7 days: no row');

 // ---- The update guard ----
 const job=async(serverId,state,claimedAt)=>{await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,claimed_at,actor,actor_email,actor_principal,parameters) VALUES (${crypto.randomUUID()},${serverId},'agent-update','4.18.0',${state},${clock-hour},${claimedAt}::bigint,'owner','owner@integrity.test','private:owner@integrity.test','{}')`);};
 await job(c.id,'pending',null);
 const planned=item('service-ended',{service:'worker'}),changed=item('protection-changed',{target:'folder-staging',repaired:true,finding:'updates inherited'});
 await post(c,report(c,[planned,changed]));
 const guarded=await rows(c.id);
 check([planned,changed].map(event=>guarded.find(row=>row.eventId===event.id)).map(row=>[row.kind,row.planned]),[['service-ended',true],['protection-changed',false]],'during a pending agent update a stop event is planned, a protection change is not');
 check((await audits(c.id)).map(row=>row.action),['agent.integrity.protection-changed'],'no audit row for the planned event');
 check((await open(c.id)).map(row=>row.ruleId),['agent-protection-changed'],'no alarm for the planned event');
 await d.exec(sql`UPDATE jobs SET state='succeeded',claimed_at=${clock-29*minute} WHERE server_id=${c.id}`);
 const after=item('service-stopped',{service:'broker'});
 await post(c,report(c,[after]));
 check((await rows(c.id)).find(row=>row.eventId===after.id).planned,true,'an update claimed 29 minutes ago still guards');
 await d.exec(sql`UPDATE jobs SET claimed_at=${clock-31*minute} WHERE server_id=${c.id}`);
 const later=item('service-stopped',{service:'broker'});
 await post(c,report(c,[later]));
 check((await rows(c.id)).find(row=>row.eventId===later.id).planned,false,'31 minutes after the claim it no longer does');
 check((await audits(c.id)).map(row=>row.action),['agent.integrity.protection-changed','agent.integrity.service-stopped'],'and writes its audit row');

 // ---- The caps: 100 stop events and 100 tamper events per 24 hours, two pools ----
 check(integrity.AGENT_INTEGRITY_TAMPER_KINDS,['start-type-changed','agent-removed','protection-changed'],'the tamper kinds');
 check(integrity.AGENT_INTEGRITY_TAMPER_KINDS.filter(kind=>contract.AGENT_INTEGRITY_STOP_KINDS.includes(kind)),[],'no tamper kind is a stop kind');
 check([...integrity.AGENT_INTEGRITY_TAMPER_KINDS,...contract.AGENT_INTEGRITY_STOP_KINDS].sort(),[...contract.AGENT_INTEGRITY_KINDS].sort(),'tamper and stop kinds together are all kinds');
 check([integrity.AGENT_INTEGRITY_DAILY_CAP,integrity.AGENT_INTEGRITY_TAMPER_DAILY_CAP],[100,100],'both caps are 100');
 const stamped=(target,kind,age,extra={})=>insertRow(d,'agent_integrity_events',{id:crypto.randomUUID(),server_id:target.id,event_id:crypto.randomUUID(),kind,occurred_at:clock-age,received_at:clock-age,...extra});
 const stopRows=async(target,count)=>{for(let index=0;index<count;index++)await stamped(target,'service-ended',hour,{service:'worker'});};
 const tamperRow=(target,index,age=hour)=>[()=>stamped(target,'start-type-changed',age,{service:'broker',start_type:'disabled'}),()=>stamped(target,'agent-removed',age,{reason:'service-deleted'}),()=>stamped(target,'protection-changed',age,{target:'folder-agent',repaired:true})][index%3]();
 const tamperRows=async(target,count)=>{for(let index=0;index<count;index++)await tamperRow(target,index);};
 const capLines=()=>errors.filter(line=>line.includes('integrity events in 24 hours'));
 const stored=async(target,events)=>(await rows(target.id)).filter(row=>events.some(event=>event.id===row.eventId)).map(row=>row.eventId).sort();
 // The stop pool: 99 stored in 24 hours (and one older row that does not count), 3 more keep only the first.
 const capped=await device('SRV-CAP');
 await stopRows(capped,99);
 await stamped(capped,'service-ended',2*day,{service:'worker'});
 errors.length=0;
 const kept=item('service-hung',{service:'worker'}),dropped=item('service-hung',{service:'worker'}),dropped2=item('service-hung',{service:'worker'});
 check((await post(capped,report(capped,[kept,dropped,dropped2]))).body.accepted,[kept.id,dropped.id,dropped2.id],'over the stop cap: all acknowledged');
 check(await stored(capped,[kept,dropped,dropped2]),[kept.id],'only the 100th stop event of 24 hours is stored');
 check(capLines().length,1,'the stop drop is logged once');
 check([capLines()[0].includes(capped.id),capLines()[0].includes('100 stop integrity events in 24 hours'),capLines()[0].includes('; 2 were acknowledged')],[true,true,true],'the stop line names the device, the cap, the pool and the 2 dropped events');
 // A full stop pool leaves the tamper events their own room.
 const tamper=await device('SRV-CAP-TAMPER');
 await stopRows(tamper,100);
 errors.length=0;
 const hung=item('service-hung',{service:'worker'}),broker=item('start-type-changed',{service:'broker',startType:'disabled'}),uninstall=item('agent-removed',{reason:'local-uninstall'}),dacl=item('protection-changed',{target:'service-dacl',service:'worker',repaired:true});
 check((await post(tamper,report(tamper,[hung,broker,uninstall,dacl]))).body.accepted,[hung.id,broker.id,uninstall.id,dacl.id],'a full stop pool: all four acknowledged');
 check(await stored(tamper,[hung,broker,uninstall,dacl]),[broker.id,uninstall.id,dacl.id].sort(),'the three tamper events are stored, the stop event is not');
 check((await audits(tamper.id)).map(row=>row.action).sort(),['agent.integrity.agent-removed','agent.integrity.protection-changed','agent.integrity.start-type-changed'],'the three tamper audit rows');
 const tamperAlarms=(await open(tamper.id)).map(row=>row.key);
 check(['agent-removed','agent-start-type-broker','agent-protection-service-dacl-worker'].filter(key=>!tamperAlarms.includes(key)),[],'the tamper alarms open');
 check([capLines().length,capLines()[0].includes(' stop integrity events'),capLines()[0].includes(tamper.id)],[1,true,true],'one log line, for the stop pool');
 // A full tamper pool leaves the stop events their room; a tamper row older than 24 hours does not count.
 const full=await device('SRV-CAP-FULL');
 await tamperRows(full,100);
 await tamperRow(full,0,2*day);
 errors.length=0;
 const repaired=item('protection-changed',{target:'folder-plugins',repaired:true}),ended=item('service-ended',{service:'worker'});
 check((await post(full,report(full,[repaired,ended]))).body.accepted,[repaired.id,ended.id],'a full tamper pool: both acknowledged');
 check(await stored(full,[repaired,ended]),[ended.id],'only the stop event is stored');
 check([capLines().length,capLines()[0].includes('100 tamper integrity events in 24 hours'),capLines()[0].includes('; 1 were acknowledged')],[1,true,true],'one log line, for the tamper pool');
 // The tamper pool keeps its first events in report order.
 const edge=await device('SRV-CAP-EDGE');
 await tamperRows(edge,99);
 errors.length=0;
 const removedA=item('agent-removed',{reason:'local-uninstall'}),removedB=item('agent-removed',{reason:'service-deleted'}),stop=item('service-stopped',{service:'worker'});
 check((await post(edge,report(edge,[removedA,removedB,stop]))).body.accepted,[removedA.id,removedB.id,stop.id],'99 tamper rows: all three acknowledged');
 check(await stored(edge,[removedA,removedB,stop]),[removedA.id,stop.id].sort(),'the first tamper event and the stop event are stored, the second tamper event is not');
 check((await audits(edge.id)).map(row=>row.action).sort(),['agent.integrity.agent-removed','agent.integrity.service-stopped'],'an audit row for each stored event');
 check(capLines().filter(line=>line.includes(' tamper integrity events')).length,1,'the tamper drop is logged');
 // Both pools full: nothing is stored, one line per pool.
 const both=await device('SRV-CAP-BOTH');
 await stopRows(both,100);await tamperRows(both,100);
 errors.length=0;
 const bothStop=item('service-restarted',{service:'worker'}),bothTamper=item('agent-removed',{reason:'service-deleted'});
 check((await post(both,report(both,[bothStop,bothTamper]))).body.accepted,[bothStop.id,bothTamper.id],'both pools full: both acknowledged');
 check([await stored(both,[bothStop,bothTamper]),(await audits(both.id)).length],[[],0],'neither is stored nor audited');
 check([capLines().length,capLines().some(line=>line.includes(' stop integrity events')),capLines().some(line=>line.includes(' tamper integrity events'))],[2,true,true],'two log lines, one per pool');
 // Room in both pools: no log line.
 errors.length=0;
 const roomy=await device('SRV-CAP-ROOM');
 await post(roomy,report(roomy,[item('service-ended',{service:'worker'}),item('agent-removed',{reason:'service-deleted'})]));
 check([(await rows(roomy.id)).length,capLines().length],[2,0],'nothing dropped: both stored and no log line');

 // ---- consoleAgentIntegrity: one statement; the console row has none ----
 const read=await device('SRV-READ'),stamp=(kind,age,extra={})=>insertRow(d,'agent_integrity_events',{id:crypto.randomUUID(),server_id:read.id,event_id:crypto.randomUUID(),kind,occurred_at:clock-age,received_at:clock-age,...extra});
 await stamp('service-ended',hour,{service:'worker'});await stamp('service-ended',2*day,{service:'worker'});
 await stamp('service-stopped',3*day,{service:'broker'});await stamp('service-stopped',5*day,{service:'broker'});
 await stamp('start-type-changed',4*day,{service:'worker',start_type:'disabled'});await stamp('start-type-changed',6*day,{service:'broker',start_type:'manual'});
 await stamp('agent-removed',10*day,{reason:'service-deleted'});await stamp('agent-removed',91*day,{reason:'service-deleted'});
 await stamp('service-hung',2*hour,{service:'worker',planned:true});
 counted.on=true;counted.statements=0;
 const read2=await integrity.consoleAgentIntegrity(JSON.stringify([read.id,c.id]),db,clock);
 counted.on=false;
 check(counted.statements,1,'consoleAgentIntegrity: one statement for several devices');
 check(read2.get(read.id).events.map(event=>[event.kind,event.service,(clock-event.receivedAt)/hour]),[['agent-removed',null,240],['start-type-changed','broker',144],['start-type-changed','worker',96],['service-stopped','broker',72],['service-ended','worker',1]],'the events of 24 hours plus the newest stop, start type per service and removal of 90 days; never a planned event');
 check(read2.get(c.id).events.some(event=>event.id&&event.kind==='service-ended'),false,'the planned event of the update stays out');
 const row=await d.one(sql`SELECT id,name,created_at AS "createdAt",last_seen AS "lastSeen",revoked,management,snapshot,'[]' AS groups FROM servers WHERE id=${read.id}`);
 const [projected]=projection.projectDevices({servers:[{...row,lastSeen:Number(row.lastSeen),createdAt:Number(row.createdAt)}],updates:[],permissionMap:new Map([[read.id,['view']]]),multipleCustomers:false,alertOverrides:[],esuOverrides:[],deviceTags:new Map(),openAlerts:new Map(),autostart:new Map(),serverSoftware:new Map(),dhcpAlerts:new Map(),dnsAlerts:new Map(),agentIntegrity:read2,evaluatedAt:clock,now:clock});
 check(projected.issues.filter(issue=>issue.ruleId.startsWith('agent-')).map(issue=>issue.key),['agent-stopped'],'the console row has the agent issue');
 check('agentIntegrity' in projected,false,'the console row carries no integrity events');
 // A removed device keeps no events.
 await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${read.id}`);
 check((await rows(read.id)).length,0,'removing the device deletes its events');

 // ---- The 90-day retention of the daily maintenance ----
 const kept90=await device('SRV-RETENTION');
 await insertRow(d,'agent_integrity_events',{id:'retention-old',server_id:kept90.id,event_id:crypto.randomUUID(),kind:'agent-removed',reason:'service-deleted',occurred_at:clock-91*day,received_at:clock-91*day});
 await insertRow(d,'agent_integrity_events',{id:'retention-new',server_id:kept90.id,event_id:crypto.randomUUID(),kind:'agent-removed',reason:'service-deleted',occurred_at:clock-89*day,received_at:clock-89*day});
 const result=await runMaintenance(d,{},{retention:{auditDays:3650,jobDays:3650},now:clock});
 check([result.integrityEvents.deleted>=1,result.integrityEvents.more],[true,false],'the maintenance deletes integrity events');
 check((await d.query(sql`SELECT id FROM agent_integrity_events WHERE server_id=${kept90.id} ORDER BY id`)).map(item=>item.id),['retention-new'],'older than 90 days: deleted; 89 days: kept');
 console.error=logError;
}finally{await d.close();}
console.log(`PASS agent integrity (${checks} checks): the strict schema with its bounds, 16 KiB, the future clamp, the 7-day drop and the caps of 100 stop events and 100 tamper events in 24 hours, two pools that cannot crowd each other out; a removed device refused; a repeated ID without a second row; one audit row per event that is not planned; the update guard; the alarms of every key with the 24-hour edges, the last Heartbeat, snapshot start types and findings, older agents and no transitions during an update; one statement and no events in the console row; the texts in English and German and the Overview area; the SRV-FILE01 sample warning; and the 90-day retention.`);
