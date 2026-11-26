// Certificates (docs/device-health-signals.md#certificates): the strict snapshot
// schema rejects private key or raw certificate fields, the days-left boundaries
// of cert-expiring, cert-expiring-no-key off by default and active after an
// override, one issue per thumbprint, the fleet tab filter counts with the
// private-key switch, and the issue texts. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {telemetry,certificateInventory}=await import('../../lib/server/agent/telemetry.ts');
const {defaultAlertSettings,evaluateAlertRules,certificateDaysLeft}=await import('../../lib/alert-rules.ts');
const {deviceIssues}=await import('../../ui/base/ui-device.ts');
const {certificateStatus,fleetCertificateRows,certificateRowShown,certificateFilterCounts,certificateBindingText,deviceCertificates}=await import('../../ui/devices/inventory/health-signals.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const now=Date.parse('2026-10-20T12:00:00.000Z'),day=86400000,hour=3600000,iso=offset=>new Date(now+offset).toISOString();
const base={hostname:'H',os:'Windows Server 2022 Standard',build:'20348',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.11.0',mode:'ReadOnly',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:[]};
let serial=0;
const thumb=()=>(++serial).toString(16).toUpperCase().padStart(40,'A');
const cert=(notAfterOffset,extra={})=>({thumbprint:thumb(),stores:['My'],subject:`CN=host${serial}.contoso.local`,sans:[`host${serial}.contoso.local`],issuer:'CN=Contoso CA',notBefore:iso(-300*day),notAfter:iso(notAfterOffset),hasPrivateKey:true,selfSigned:false,bindings:[],...extra});
const inventory=(items,extra={})=>({collectedAt:iso(0),items,truncated:false,...extra});

// ---- Schema ----
const good=inventory([cert(12*day,{stores:['My','Remote Desktop'],bindings:[{type:'rdp',endpoint:'RDP-Tcp'}]}),cert(3*day,{bindings:[{type:'https',endpoint:'0.0.0.0:443'}]}),cert(-2*day,{hasPrivateKey:false})]);
check(telemetry.safeParse({...base,certificates:good}).success,true,'a valid inventory');
check(telemetry.safeParse({...base,agentVersion:'4.10.0'}).success,true,'a 4.10.x snapshot without certificates stays valid');
for(const [label,value] of [
 ['a privateKey field',inventory([{...cert(10*day),privateKey:'-----BEGIN '+'PRIVATE'+' KEY-----'}])],
 ['a rawData field',inventory([{...cert(10*day),rawData:'MIIB'}])],
 ['a pem field on the inventory',{...good,pem:'-----BEGIN CERTIFICATE-----'}],
 ['a lower-case thumbprint',inventory([cert(10*day,{thumbprint:'a'.repeat(40)})])],
 ['an unknown store',inventory([cert(10*day,{stores:['Root']})])],
 ['no store',inventory([cert(10*day,{stores:[]})])],
 ['more than 10 SANs',inventory([cert(10*day,{sans:Array.from({length:11},(_,index)=>`h${index}`)})])],
 ['an unknown binding type',inventory([cert(10*day,{bindings:[{type:'ftp',endpoint:'x'}]})])],
 ['an RDP binding on another listener',inventory([cert(10*day,{bindings:[{type:'rdp',endpoint:'RDP-Udp'}]})])],
 ['more than 100 certificates',inventory(Array.from({length:101},()=>cert(10*day)))],
])check(certificateInventory.safeParse(value).success,false,`rejects ${label}`);

// ---- Days left ----
check([certificateDaysLeft(iso(31*day),now),certificateDaysLeft(iso(30*day),now),certificateDaysLeft(iso(29*day+hour),now),certificateDaysLeft(iso(hour),now),certificateDaysLeft(iso(0),now),certificateDaysLeft(iso(-hour),now),certificateDaysLeft(iso(-3*day),now)],[31,30,30,1,0,-1,-3],'whole days rounded up before expiry, rounded down after it (0 at the moment of expiry)');

// ---- Rules ----
const issues=(items,settings=defaultAlertSettings())=>evaluateAlertRules({lastSeen:now,snapshot:{...base,certificates:inventory(items)}},settings,now).filter(issue=>issue.ruleId.startsWith('cert-'));
const level=(offset,extra)=>issues([cert(offset,extra)]).map(issue=>issue.level);
check([level(31*day),level(30*day),level(8*day),level(7*day),level(0),level(-5*day)],[[],['warning'],['warning'],['critical'],['critical'],['critical']],'boundaries: 31 none, 30 warning, 8 warning, 7 critical, 0 and expired critical');
const one=cert(12*day,{stores:['My','Remote Desktop']});
check(issues([one])[0],{key:`cert-${one.thumbprint}`,ruleId:'cert-expiring',level:'warning',live:false,params:{subject:one.subject,notAfter:one.notAfter,daysLeft:12,stores:['My','Remote Desktop']}},'key and params');
check(level(-5*day,{hasPrivateKey:false}),[],'cert-expiring-no-key is off by default');
check(issues([cert(-5*day,{hasPrivateKey:false})],{...defaultAlertSettings(),'cert-expiring-no-key':{enabled:true,warning:30,critical:7,level:null,durationMinutes:null,recovery:null}}).map(issue=>`${issue.ruleId}:${issue.level}`),['cert-expiring-no-key:critical'],'active after an override');
check(issues([cert(5*day)],{...defaultAlertSettings(),'cert-expiring':{enabled:false,warning:30,critical:7,level:null,durationMinutes:null,recovery:null}}),[],'cert-expiring disabled');
const twice=cert(10*day);
check(issues([twice,{...twice,stores:['WebHosting']}]).length,1,'a duplicate thumbprint gives one issue');
check(issues([cert(10*day,{notAfter:'not a date'})]),[],'an unreadable date gives no issue');
check(evaluateAlertRules({lastSeen:now,snapshot:base},defaultAlertSettings(),now).filter(issue=>issue.ruleId.startsWith('cert-')),[],'an older agent: no issue');

// ---- Fleet tab ----
const device=(id,items)=>({id,name:id.toUpperCase(),snapshot:{...base,certificates:inventory(items)}});
const servers=[
 device('a',[cert(12*day),cert(3*day),cert(200*day)]),
 device('b',[cert(-2*day),cert(-20*day,{hasPrivateKey:false}),cert(25*day,{hasPrivateKey:false})]),
 {id:'c',name:'C',snapshot:base},
];
const rows=fleetCertificateRows(servers,now);
check(rows.map(row=>[row.deviceId,row.status,row.daysLeft]),[['b','expired',-20],['b','expired',-2],['a','expiring',3],['a','expiring',12],['b','expiring',25],['a','valid',200]],'rows of all devices, sorted by expiry');
check(certificateFilterCounts(rows,true),{expiring:2,expired:1,all:4},'counts with the private-key switch on (default)');
check(certificateFilterCounts(rows,false),{expiring:3,expired:2,all:6},'counts with the switch off');
check(rows.filter(row=>certificateRowShown(row,'expired',true)).map(row=>row.daysLeft),[-2],'expired with private key');
check(rows.filter(row=>certificateRowShown(row,'expiring',false)).map(row=>row.daysLeft),[3,12,25],'expiring in 30 days without the switch');
check([certificateStatus({notAfter:iso(31*day)},now).status,certificateStatus({notAfter:iso(30*day)},now).status,certificateStatus({notAfter:iso(-hour)},now).status],['valid','expiring','expired'],'the status pill uses the 30-day window');
check(deviceCertificates(servers[0]).map(item=>certificateDaysLeft(item.notAfter,now)),[3,12,200],'the device area sorts by notAfter ascending');
check([certificateBindingText({type:'https',endpoint:'0.0.0.0:443'},'en'),certificateBindingText({type:'rdp',endpoint:'RDP-Tcp'},'en'),certificateBindingText({type:'rdp',endpoint:'RDP-Tcp'},'de')],['HTTPS 0.0.0.0:443','Remote Desktop','Remotedesktop'],'binding texts');

// ---- Issue texts ----
const evaluated=items=>{const server={id:'d',name:'D',createdAt:0,revoked:0,management:0,lastSeen:now,snapshot:{...base,certificates:inventory(items)}};return {...server,issues:evaluateAlertRules(server,defaultAlertSettings(),now)};};
const texts=(items,locale)=>deviceIssues(evaluated(items),now,locale).map(item=>[item.title,item.detail]);
const expiring=cert(Date.parse('2026-11-01T00:00:00.000Z')-now,{subject:'CN=rdp.contoso.local',stores:['My','Remote Desktop']});
const expired=cert(Date.parse('2026-10-15T00:00:00.000Z')-now,{subject:'CN=old.contoso.local'});
check(texts([expiring],'en'),[['Certificate CN=rdp.contoso.local expires in 12 days',texts([expiring],'en')[0][1]]],'expiring title (en)');
assert.match(texts([expiring],'en')[0][1],/^Valid until .+\. Store: My, Remote Desktop\.$/,'detail with the date and the stores');checks++;
check(texts([expired],'en')[0][0],'Certificate CN=old.contoso.local has expired','expired title (en)');
check(texts([expiring],'de')[0][0],'Zertifikat CN=rdp.contoso.local läuft in 12 Tagen ab','expiring title (de)');
check(texts([expired],'de')[0][0],'Zertifikat CN=old.contoso.local ist abgelaufen','expired title (de)');

console.log(`PASS certificates (${checks} checks): strict schema without private key or raw data, days-left boundaries 31/30/8/7/0/expired, cert-expiring-no-key off by default and on after an override, one issue per thumbprint, fleet filter counts and the private-key switch, issue texts.`);
