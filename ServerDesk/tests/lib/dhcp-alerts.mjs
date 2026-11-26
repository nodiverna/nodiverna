// The two DHCP alert rules (lib/alert-rules.ts, docs/alert-rules.md): "DHCP
// scope almost full" and "DHCP service stopped" fire and stay silent on fresh,
// stale and missing data, inactive scopes, scopes without addresses and a
// threshold override; the readings; the alarm sync on PostgreSQL opens and
// closes a scope alarm with the 5-point recovery margin from the stored plugin
// data; the console row never carries the DHCP data; the issue texts and the
// area of both rules; and the warning of the sample server SRV-DC01.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {HttpError} from '../support/http-error.mjs';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
const rules=await import('../../lib/alert-rules.ts');
const {alarmTarget}=await import('../../ui/base/health-score.ts');
const {issueText,issueTarget}=await import('../../ui/base/ui-device.ts');
const {demoData}=await import('../../ui/shell/demo.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const now=Date.UTC(2026,10,4,12),minute=60_000;
const settings=rules.defaultAlertSettings();
const scope=(scopeId,percent,{state='active',total=100}={})=>({scopeId,state,inUse:Math.round(total*percent/100),total,percent});
const data=(scopes,{service='running',age=5*minute}={})=>({service,collectedAt:now-age,scopes});
const server=dhcpAlerts=>({snapshot:{cpu:5,memory:5,disks:[]},lastSeen:now-10_000,dhcpAlerts});
const dhcpIssues=(dhcpAlerts,own=settings)=>rules.evaluateAlertRules(server(dhcpAlerts),own,now).filter(issue=>issue.ruleId.startsWith('dhcp-'));

// ---- The rules ----------------------------------------------------------------------------------
check(dhcpIssues(data([scope('10.20.0.0',93),scope('10.10.0.0',62)])),[{key:'dhcp-scope-10.20.0.0',ruleId:'dhcp-scope-full',level:'warning',live:false,params:{scope:'10.20.0.0',inUse:93,total:100,percent:93}}],'one warning for the scope at 93 %, none for 62 %');
check(dhcpIssues(data([scope('10.20.0.0',90)])).length,1,'90 % is at the threshold');
check(dhcpIssues(data([scope('10.30.0.0',95,{state:'inactive'})])),[],'an inactive scope makes no issue');
check(dhcpIssues(data([{scopeId:'10.40.0.0',state:'active',inUse:0,total:0,percent:100}])),[],'a scope without addresses makes no issue');
check(dhcpIssues(data([scope('10.20.0.0',99)],{age:61*minute})),[],'data older than 60 minutes make no issue');
check(dhcpIssues(data([scope('10.20.0.0',99)],{age:60*minute})).length,1,'data of exactly 60 minutes still count');
check(dhcpIssues(undefined),[],'no data make no issue');
check(dhcpIssues(data([],{service:'stopped'})),[{key:'dhcp-service',ruleId:'dhcp-service-stopped',level:'critical',live:false,params:{}}],'a stopped service is critical, without params');
check(dhcpIssues(data([],{service:'stopped',age:2*60*minute})),[],'a stale stopped service makes no issue');
check(dhcpIssues(data([],{service:null})),[],'an unknown service makes no issue');
const strict={...settings,'dhcp-scope-full':{...settings['dhcp-scope-full'],warning:60,critical:80}};
check(dhcpIssues(data([scope('10.10.0.0',62),scope('10.20.0.0',93)]),strict).map(issue=>[issue.key,issue.level]),[['dhcp-scope-10.20.0.0','critical'],['dhcp-scope-10.10.0.0','warning']],'a threshold override with a critical step');
const off={...settings,'dhcp-scope-full':{...settings['dhcp-scope-full'],enabled:false},'dhcp-service-stopped':{...settings['dhcp-service-stopped'],enabled:false}};
check(dhcpIssues(data([scope('10.20.0.0',99)],{service:'stopped'}),off),[],'both rules can be turned off');
check(dhcpIssues(data([],{service:'stopped'}),{...settings,'dhcp-service-stopped':{...settings['dhcp-service-stopped'],level:'warning'}})[0].level,'warning','the level of the stopped rule can change');
// The readings: the percent of every active scope with addresses from fresh data.
check(rules.alertReadings(server(data([scope('10.20.0.0',93),scope('10.30.0.0',50,{state:'inactive'}),scope('10.10.0.0',62)])),now).filter(reading=>reading.ruleId==='dhcp-scope-full'),[{ruleId:'dhcp-scope-full',key:'dhcp-scope-10.20.0.0',value:93},{ruleId:'dhcp-scope-full',key:'dhcp-scope-10.10.0.0',value:62}],'the readings of the active scopes');
check(rules.alertReadings(server(data([scope('10.20.0.0',93)],{age:2*60*minute})),now).filter(reading=>reading.ruleId==='dhcp-scope-full'),[],'no readings from stale data');
// Areas and texts.
check([alarmTarget('dhcp-scope-full'),alarmTarget('dhcp-service-stopped')],[{section:'extensions',detail:'dhcp'},{section:'extensions',detail:'dhcp'}],'both rules open the DHCP view');
{
 const full=issueText({key:'dhcp-scope-10.20.0.0',ruleId:'dhcp-scope-full',level:'warning',live:false,params:{scope:'10.20.0.0',inUse:93,total:100,percent:93}},'en',now);
 check([full.title,full.detail],['DHCP scope 10.20.0.0 is 93% full','93 of 100 addresses in use'],'the scope issue text');
 const stopped=issueText({key:'dhcp-service',ruleId:'dhcp-service-stopped',level:'critical',live:false,params:{}},'de',now);
 check([stopped.title,stopped.detail],['Dienst DHCP-Server gestoppt','Clients bekommen von diesem Server keine Adressen.'],'the German stopped issue text');
}
// The sample server: Wi-Fi Guests at 93 % through the same evaluation.
const demo=demoData().servers.find(device=>device.name==='SRV-DC01');
check(demo.issues.filter(issue=>issue.ruleId==='dhcp-scope-full').map(issue=>[issue.key,issue.level,issue.params.percent]),[['dhcp-scope-10.20.0.0','warning',93]],'the sample SRV-DC01 shows the warning for 10.20.0.0');
check(demo.alerts.some(alert=>alert.ruleId==='dhcp-scope-full'&&alert.key==='dhcp-scope-10.20.0.0'),true,'and its alarm');
check('dhcpAlerts' in demo,false,'the sample row carries no DHCP data');
// The health line and the Problems tab agree: each scope issue of the sample links to the DHCP server of the Roles tab.
for(const issue of demo.issues.filter(item=>item.ruleId==='dhcp-scope-full')){
 const link=issueTarget(issue,demo),area=alarmTarget(issue.ruleId,issue.params,demo);
 check(link,{section:'extensions',extensions:'dhcp'},'the health line links the scope issue to the DHCP server');
 check([link.section,link.extensions],[area.section,area.detail],'the same section and detail as the Problems tab');
}

// ---- The alarm sync on PostgreSQL ----------------------------------------------------------------
const d=await sourceDatabase();
try{
 let clock=now;
 const stub={db:()=>d,now:()=>clock,config:()=>'',HttpError,guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),body:request=>request.json()};
 const load=sourceLoader(),imports={'../context':stub,'./context':stub,'@/lib/server/context':stub};
 const alerts=load('lib/server/devices/alerts.ts',imports),projection=load('lib/server/devices/device-projection.ts',imports),plugins=load('lib/server/extensions/plugin-data.ts',imports);
 const id=crypto.randomUUID();
 await insertRow(d,'servers',{id,name:'SRV-DHCP',token_hash:'fixture-'+id,created_at:now-86_400_000,last_seen:now,management:1,snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.17.0',mode:'Management',cpu:5,memory:5,disks:[],processes:[],agentCapabilities:['plugin-host'],plugins:[]})});
 const store=async(percent,{service='running',at=clock}={})=>{
  const summary=JSON.stringify([{family:'ipv4',scopeId:'10.20.0.0',name:'Guests',range:'10.20.0.10 – 10.20.0.109',state:'active',inUse:percent,total:100,percent}]);
  await d.exec(sql`INSERT INTO device_plugin_data (server_id,plugin,operation,data,summary,collected_at,received_at,service) VALUES (${id},'dhcp','dhcp-read','{}',${summary},${at},${at},${service})
   ON CONFLICT (server_id,plugin,operation) DO UPDATE SET summary=excluded.summary,collected_at=excluded.collected_at,received_at=excluded.received_at,service=excluded.service`);
 };
 const open=()=>d.query(sql`SELECT rule_id AS "ruleId",key,state,level,peak_value AS peak FROM alerts WHERE server_id=${id} AND state<>'closed' AND rule_id LIKE 'dhcp-%' ORDER BY rule_id,key`);
 await store(93);await alerts.syncDeviceAlerts(id,clock);
 check(await open(),[{ruleId:'dhcp-scope-full',key:'dhcp-scope-10.20.0.0',state:'open',level:'warning',peak:93}],'93 %: the alarm opens at once (no minimum duration)');
 clock+=minute;await store(87);await alerts.syncDeviceAlerts(id,clock);
 check((await open()).length,1,'87 %: below the threshold but inside the 5-point recovery margin, the alarm stays open');
 clock+=minute;await store(84);await alerts.syncDeviceAlerts(id,clock);
 check(await open(),[],'84 %: beyond the margin, the alarm closes');
 check((await d.one(sql`SELECT close_reason FROM alerts WHERE server_id=${id} AND rule_id='dhcp-scope-full'`)).close_reason!==null,true,'with a close reason');
 clock+=minute;await store(10,{service:'stopped'});await alerts.syncDeviceAlerts(id,clock);
 check((await open()).map(row=>[row.ruleId,row.level]),[['dhcp-service-stopped','critical']],'a stopped service opens its alarm');
 clock+=61*minute;await alerts.syncDeviceAlerts(id,clock);
 check(await open(),[],'the data age past 60 minutes: the alarm closes');
 // The console projection evaluates the DHCP data but never sends them.
 await store(95,{at:clock});
 const dhcpAlerts=await plugins.consoleDhcpAlerts(JSON.stringify([id]));
 const row=(await d.one(sql`SELECT id,name,created_at AS "createdAt",last_seen AS "lastSeen",revoked,management,snapshot,'[]' AS groups FROM servers WHERE id=${id}`));
 const [projected]=projection.projectDevices({servers:[{...row,lastSeen:Number(row.lastSeen),createdAt:Number(row.createdAt)}],updates:[],permissionMap:new Map([[id,['view']]]),multipleCustomers:false,alertOverrides:[],esuOverrides:[],deviceTags:new Map(),openAlerts:new Map(),autostart:new Map(),serverSoftware:new Map(),dhcpAlerts,dnsAlerts:new Map(),evaluatedAt:clock,now:clock});
 check(projected.issues.filter(issue=>issue.ruleId==='dhcp-scope-full').map(issue=>issue.key),['dhcp-scope-10.20.0.0'],'the console row has the DHCP issue');
 check('dhcpAlerts' in projected,false,'the console row carries no DHCP data');
}finally{await d.close();}
console.log(`PASS DHCP alerts (${checks} checks): both rules on fresh, stale and missing data, inactive and empty scopes, overrides and levels, the readings, areas and texts, the sample warning, the alarm open and close with the recovery margin, and no DHCP data in the console row.`);
