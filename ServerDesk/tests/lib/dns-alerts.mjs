// The alert rule "DNS service stopped" (lib/alert-rules.ts, docs/alert-rules.md):
// it fires on fresh data with a stopped service and stays silent on stale,
// missing and running data; the alarm sync on PostgreSQL opens and closes it
// from the stored plugin data; the console row never carries the DNS data; the
// issue texts, the area, the link only with the detected DNS role, and the
// sample server SRV-DC01 without the issue.
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
const {translate}=await import('../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const now=Date.UTC(2026,10,9,12),minute=60_000;
const settings=rules.defaultAlertSettings();
const data=(service,age=5*minute)=>({service,collectedAt:now-age});
const server=dnsAlerts=>({snapshot:{cpu:5,memory:5,disks:[]},lastSeen:now-10_000,dnsAlerts});
const dnsIssues=(dnsAlerts,own=settings)=>rules.evaluateAlertRules(server(dnsAlerts),own,now).filter(issue=>issue.ruleId.startsWith('dns-'));

// ---- The rule -------------------------------------------------------------------------------------
const rule=rules.alertRules.find(item=>item.id==='dns-service-stopped');
check([rule.kind,settings['dns-service-stopped'].level,settings['dns-service-stopped'].enabled],['boolean','critical',true],'a boolean rule, critical, on by default');
check(rules.alertRules.findIndex(item=>item.id==='dns-service-stopped'),rules.alertRules.findIndex(item=>item.id==='dhcp-service-stopped')+1,'directly after DHCP service stopped');
check(rules.alertRules.at(-1).id,'device-offline','Device offline stays last');
check(dnsIssues(data('stopped')),[{key:'dns-service',ruleId:'dns-service-stopped',level:'critical',live:false,params:{}}],'a stopped service on fresh data: critical, without params');
check(dnsIssues(data('stopped',60*minute)).length,1,'data of exactly 60 minutes still count');
check(dnsIssues(data('stopped',61*minute)),[],'data older than 60 minutes make no issue');
check(dnsIssues(undefined),[],'no data make no issue');
check(dnsIssues(data('running')),[],'a running service makes no issue');
check(dnsIssues(data(null)),[],'an unknown service makes no issue');
check(dnsIssues(data('stopped'),{...settings,'dns-service-stopped':{...settings['dns-service-stopped'],enabled:false}}),[],'the rule can be turned off');
check(dnsIssues(data('stopped'),{...settings,'dns-service-stopped':{...settings['dns-service-stopped'],level:'warning'}})[0].level,'warning','its level can change');
check(rules.evaluateAlertRules({...server(data('stopped')),dhcpAlerts:{service:'stopped',collectedAt:now,scopes:[]}},settings,now).filter(issue=>issue.ruleId.endsWith('-service-stopped')).map(issue=>issue.key),['dhcp-service','dns-service'],'DHCP and DNS side by side');
// Names, descriptions, texts and the area.
check(['en','de'].map(locale=>translate(locale,'alertRules.rule.dnsServiceStopped.name')),['DNS service stopped','DNS-Dienst gestoppt'],'the rule name in both catalogs');
check(translate('en','alertRules.rule.dnsServiceStopped.critical'),'Critical when the DNS extension reports the DNS Server service as stopped.','the rule description');
const issue={key:'dns-service',ruleId:'dns-service-stopped',level:'critical',live:false,params:{}};
check(Object.values(issueText(issue,'en',now)),['DNS Server service stopped','Clients that use this server cannot resolve names.'],'the English issue text');
check(Object.values(issueText(issue,'de',now)),['Dienst DNS-Server gestoppt','Clients, die diesen Server verwenden, können keine Namen auflösen.'],'the German issue text');
check(alarmTarget('dns-service-stopped'),{section:'extensions',detail:'dns'},'the rule opens the DNS view of the Extensions area');
const withDns={snapshot:{os:'Microsoft Windows Server 2022 Datacenter',features:[{name:'DNS',displayName:'DNS Server',installed:true,featureType:'Role'}]}};
const dhcpOnly={snapshot:{os:'Microsoft Windows Server 2022 Datacenter',features:[{name:'DHCP',displayName:'DHCP Server',installed:true,featureType:'Role'}]}};
check(issueTarget(issue,withDns),{section:'extensions',extensions:'dns'},'the issue links to the DNS server with the DNS role');
check(issueTarget(issue,dhcpOnly),null,'without the DNS role the issue has no link');
check(issueTarget({...issue,ruleId:'dhcp-service-stopped',key:'dhcp-service'},dhcpOnly),{section:'extensions',extensions:'dhcp'},'the DHCP link stays');
// The sample server: its DNS service runs.
const demo=demoData().servers.find(device=>device.name==='SRV-DC01');
check(demo.issues.filter(item=>item.ruleId==='dns-service-stopped'),[],'the sample SRV-DC01 has no DNS issue');
check('dnsAlerts' in demo,false,'the sample row carries no DNS data');

// ---- The alarm sync on PostgreSQL ----------------------------------------------------------------
const d=await sourceDatabase();
try{
 let clock=now;
 const stub={db:()=>d,now:()=>clock,config:()=>'',HttpError,guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),body:request=>request.json()};
 const load=sourceLoader(),imports={'../context':stub,'./context':stub,'@/lib/server/context':stub};
 const alerts=load('lib/server/devices/alerts.ts',imports),projection=load('lib/server/devices/device-projection.ts',imports),dnsData=load('lib/server/extensions/dns-data.ts',imports);
 const id=crypto.randomUUID();
 await insertRow(d,'servers',{id,name:'SRV-DNS',token_hash:'fixture-'+id,created_at:now-86_400_000,last_seen:now,management:1,snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.20.0',mode:'Management',cpu:5,memory:5,disks:[],processes:[],agentCapabilities:['plugin-host'],plugins:[]})});
 const store=async(service,at=clock)=>d.exec(sql`INSERT INTO device_plugin_data (server_id,plugin,operation,data,summary,collected_at,received_at,service) VALUES (${id},'dns','dns-read','{}','[]',${at},${at},${service})
  ON CONFLICT (server_id,plugin,operation) DO UPDATE SET collected_at=excluded.collected_at,received_at=excluded.received_at,service=excluded.service`);
 const open=()=>d.query(sql`SELECT rule_id AS "ruleId",key,state,level FROM alerts WHERE server_id=${id} AND state<>'closed' AND rule_id LIKE 'dns-%' ORDER BY rule_id,key`);
 await store('running');await alerts.syncDeviceAlerts(id,clock);
 check(await open(),[],'a running service: no alarm');
 clock+=minute;await store('stopped');await alerts.syncDeviceAlerts(id,clock);
 check(await open(),[{ruleId:'dns-service-stopped',key:'dns-service',state:'open',level:'critical'}],'a stopped service opens its alarm');
 clock+=minute;await store('running');await alerts.syncDeviceAlerts(id,clock);
 check(await open(),[],'a start and the next read close it');
 clock+=minute;await store('stopped');await alerts.syncDeviceAlerts(id,clock);
 check((await open()).length,1,'stopped again');
 clock+=61*minute;await alerts.syncDeviceAlerts(id,clock);
 check(await open(),[],'the data age past 60 minutes: the alarm closes');
 // The console projection evaluates the DNS data but never sends them.
 await store('stopped',clock);
 const dnsAlerts=await dnsData.consoleDnsAlerts(JSON.stringify([id]));
 const row=await d.one(sql`SELECT id,name,created_at AS "createdAt",last_seen AS "lastSeen",revoked,management,snapshot,'[]' AS groups FROM servers WHERE id=${id}`);
 const [projected]=projection.projectDevices({servers:[{...row,lastSeen:Number(clock),createdAt:Number(row.createdAt)}],updates:[],permissionMap:new Map([[id,['view']]]),multipleCustomers:false,alertOverrides:[],esuOverrides:[],deviceTags:new Map(),openAlerts:new Map(),autostart:new Map(),serverSoftware:new Map(),dhcpAlerts:new Map(),dnsAlerts,evaluatedAt:clock,now:clock});
 check(projected.issues.filter(item=>item.ruleId==='dns-service-stopped').map(item=>item.key),['dns-service'],'the console row has the DNS issue');
 check('dnsAlerts' in projected,false,'the console row carries no DNS data');
 const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../../lib/server/devices/assistant-tools.ts',import.meta.url),'utf8'));
 check(/consoleDnsAlerts\(scope\)/.test(source)&&/dhcpAlerts,dnsAlerts,agentIntegrity,evaluatedAt/.test(source),true,'the assistant projection passes the DNS data');
}finally{await d.close();}
console.log(`PASS DNS alerts (${checks} checks): the rule after DHCP service stopped on fresh, stale, missing, running and unknown data, its settings, names, texts and area, the link only with the DNS role, the sample server, the alarm open and close on PostgreSQL, and no DNS data in the console row.`);
