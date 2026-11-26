// The OS lifecycle catalog (lib/os-lifecycle.json) and the support status
// (lib/os-support.ts): schema, mapping of Windows 10 and Windows 11 21H2–26H2,
// LTSC and Server 2016–2025, the dates of the 2026-11-04 lifecycle check,
// status boundaries, ESU resolution (device > group > customer) and the catalog age. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {osLifecycleCatalog,osLifecycleEntry,osSupportStatus,resolveEsu,effectiveSupportEnd,windowsChannel,osSupportWarningDays,deviceOsSupport,osSupportMappers}=await import('../../lib/os-support.ts');
const {defaultAlertSettings,osSupportDaysLeft}=await import('../../lib/alert-rules.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

// ---- Schema ----
const catalog=osLifecycleCatalog,entries=catalog.entries,dateOk=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
check(catalog.schemaVersion,1,'schema version 1');ok(dateOk(catalog.asOf),'asOf is a date');
check(new Set(entries.map(entry=>entry.id)).size,entries.length,'unique ids');
for(const entry of entries){
 const label=entry.id;
 check(Object.keys(entry).filter(key=>!['id','family','product','version','build','channel','editions','start','generalEnd','securityEnd','source','checkedAt'].includes(key)),[],`${label}: no unknown keys`);
 ok(entry.family==='windows'&&['home-pro','enterprise-education','ltsc','server'].includes(entry.channel),`${label}: family and channel`);
 ok(/^https:\/\/learn\.microsoft\.com\/lifecycle\/products\//.test(entry.source),`${label}: https source of the Microsoft lifecycle page`);
 ok(['start','generalEnd','securityEnd','checkedAt'].every(key=>dateOk(entry[key])),`${label}: valid dates`);
 ok(entry.start<entry.generalEnd&&entry.generalEnd<=entry.securityEnd,`${label}: start < generalEnd <= securityEnd`);
 ok(Number.isInteger(entry.build.min)&&entry.build.min<=entry.build.max,`${label}: build range`);
 ok(!entry.editions||Array.isArray(entry.editions)&&entry.editions.length>0,`${label}: editions narrow the entry`);
}
// No overlapping build ranges per channel and edition list.
const byGroup=new Map();
for(const entry of entries){const key=`${entry.channel}|${(entry.editions??[]).join(',')}`;byGroup.set(key,[...(byGroup.get(key)??[]),entry]);}
for(const [key,list] of byGroup)for(const a of list)for(const b of list)if(a!==b)ok(a.build.max<b.build.min||b.build.max<a.build.min,`${key}: ${a.id} and ${b.id} do not overlap`);

// ---- Catalog age: fails when asOf or any checkedAt is more than 183 days old (the real date, not the test clock). ----
const realNow=performance.timeOrigin+performance.now(),limit=183*86400000;
ok(realNow-Date.parse(catalog.asOf+'T00:00:00Z')<=limit,`the catalog asOf ${catalog.asOf} is at most 183 days old: update lib/os-lifecycle.json from the Microsoft lifecycle pages`);
for(const entry of entries)ok(realNow-Date.parse(entry.checkedAt+'T00:00:00Z')<=limit,`${entry.id} was checked at most 183 days ago (${entry.checkedAt})`);
// The catalog is checked as one unit: every checkedAt equals asOf.
for(const entry of entries)check(entry.checkedAt,catalog.asOf,`${entry.id}: checkedAt equals the catalog asOf`);

// ---- Mapping ----
const snapshot=(editionId,currentBuild,installationType='Client')=>({os:'Windows',build:currentBuild,osInfo:{editionId,installationType,displayVersion:null,ubr:1,productName:'Windows',currentBuild}});
const mapped=(editionId,build,installation)=>osLifecycleEntry(snapshot(editionId,build,installation))?.id??null;
const win10={1507:10240,1511:10586,1607:14393,1703:15063,1709:16299,1803:17134,1809:17763,1903:18362,1909:18363,2004:19041,'20H2':19042,'21H1':19043,'21H2':19044,'22H2':19045};
const win11={'21H2':22000,'22H2':22621,'23H2':22631,'24H2':26100,'25H2':26200,'26H1':28000,'26H2':26300};
for(const [version,build] of Object.entries(win10)){
 for(const edition of ['Core','Professional'])check(mapped(edition,String(build)),`windows-10-${version.toLowerCase()}-home-pro`,`Windows 10 ${version} ${edition}`);
 for(const edition of ['Enterprise','Education'])check(mapped(edition,String(build)),`windows-10-${version.toLowerCase()}-enterprise-education`,`Windows 10 ${version} ${edition}`);
}
for(const [version,build] of Object.entries(win11)){
 for(const edition of ['Core','Professional','ProfessionalWorkstation'])check(mapped(edition,String(build)),`windows-11-${version.toLowerCase()}-home-pro`,`Windows 11 ${version} ${edition}`);
 for(const edition of ['Enterprise','Education','EnterpriseN'])check(mapped(edition,String(build)),`windows-11-${version.toLowerCase()}-enterprise-education`,`Windows 11 ${version} ${edition}`);
}
check(mapped('EnterpriseS','10240'),'windows-10-ltsb-2015','LTSB 2015');
check(mapped('EnterpriseS','14393'),'windows-10-ltsb-2016','LTSB 2016');
check(mapped('EnterpriseS','17763'),'windows-10-ltsc-2019','LTSC 2019');
check(mapped('EnterpriseS','19044'),'windows-10-ltsc-2021','LTSC 2021');
check(mapped('EnterpriseSN','19044'),'windows-10-ltsc-2021','LTSC 2021 N');
check(mapped('EnterpriseS','26100'),'windows-11-ltsc-2024','LTSC 2024');
check(mapped('IoTEnterpriseS','19044'),'windows-10-iot-ltsc-2021','IoT LTSC 2021 wins over the entry without editions');
check(mapped('IoTEnterpriseS','26100'),'windows-11-iot-ltsc-2024','IoT LTSC 2024');
check(mapped('IoTEnterprise','22631'),'windows-11-23h2-enterprise-education','IoT Enterprise (not LTSC) is Enterprise');
for(const [version,build] of [['2016','14393'],['2019','17763'],['2022','20348'],['2025','26100']]){
 for(const edition of ['ServerStandard','ServerDatacenter'])check(mapped(edition,build,'Server'),`windows-server-${version}`,`Server ${version} ${edition}`);
 check(mapped('ServerStandard',build,'Server Core'),`windows-server-${version}`,`Server ${version} Server Core`);
 check(mapped('ServerDatacenterEval',build,'Server'),`windows-server-${version}`,`Server ${version} by edition prefix`);
}
check(mapped('EnterpriseS','17763'),'windows-10-ltsc-2019','build 17763 as LTSC');check(mapped('ServerStandard','17763','Server'),'windows-server-2019','build 17763 as Server: another entry');
check(mapped('Professional','99999'),null,'an unknown build');
check(mapped('Cloud','22631'),null,'an unknown edition');
check(windowsChannel('Something',null),null,'unknown edition: no channel');
check(windowsChannel(null,'Server'),'server','installation type Server');
// The 2026-11-04 lifecycle check: 1511 Enterprise/Education ends with its lifecycle page (2017-10-10), and the 26H1/26H2 dates.
const win1511=osLifecycleEntry(snapshot('Enterprise','10586'));
check([win1511.id,win1511.generalEnd,win1511.securityEnd],['windows-10-1511-enterprise-education','2017-10-10','2017-10-10'],'Windows 10 1511 Enterprise/Education ended on 2017-10-10');
const homePro='https://learn.microsoft.com/lifecycle/products/windows-11-home-and-pro',enterpriseEducation='https://learn.microsoft.com/lifecycle/products/windows-11-enterprise-and-education';
for(const [id,start,end,source] of [['windows-11-26h1-home-pro','2026-02-10','2028-03-14',homePro],['windows-11-26h2-home-pro','2026-09-29','2028-10-09',homePro],['windows-11-26h1-enterprise-education','2026-02-10','2029-03-13',enterpriseEducation],['windows-11-26h2-enterprise-education','2026-09-29','2029-10-09',enterpriseEducation]]){
 const entry=entries.find(candidate=>candidate.id===id);
 check([entry?.start,entry?.generalEnd,entry?.securityEnd,entry?.source],[start,end,end,source],`${id}: start, end and source`);
}
check(osLifecycleEntry(snapshot('Professional','19045')).securityEnd,'2025-10-14','Windows 10 22H2 home-pro ended on 2025-10-14');
check(Object.keys(osSupportMappers),['windows'],'one mapper per family, windows only');
check(osLifecycleEntry({os:'Windows 11 Pro',build:'22631',osInfo:{editionId:'Professional',installationType:'Client',displayVersion:'23H2',ubr:1,productName:'Windows 10 Pro',currentBuild:null}})?.id,'windows-11-23h2-home-pro','currentBuild falls back to build');

// ---- Status ----
const day=86400000,entry=osLifecycleEntry(snapshot('Professional','19045')),end=Date.parse('2025-10-14T00:00:00Z');
const status=now=>osSupportStatus(snapshot('Professional','19045'),entry,null,now,180);
check(status(end-181*day).status,'supported','181 days left: supported');
check([status(end-180*day).status,status(end-180*day).daysLeft],['ending',180],'180 days left: ending');
check([status(end-1*day).status,status(end-1*day).daysLeft],['ending',1],'1 day left: ending');
check([status(end-day/2).status,status(end-day/2).daysLeft],['ending',1],'half a day left rounds up to 1');
check([status(end).status,status(end).daysLeft],['ended',0],'0 days left: ended');
check(status(end+5*day).status,'ended','after the end');
check(osSupportStatus(snapshot('Professional','99999'),null,null,end,180),{status:'unknown',reason:'no-entry'},'osInfo without an entry: unknown, no-entry');
check(osSupportStatus({os:'Windows'},null,null,end,180),{status:'unknown',reason:'not-reported'},'no osInfo: not-reported');
check(osSupportStatus(null,null,null,end,180),{status:'unknown',reason:'not-reported'},'no snapshot: not-reported');
check(status(end-day).entry,{id:entry.id,product:'Windows 10',version:'22H2',channel:'home-pro',generalEnd:'2025-10-14',securityEnd:'2025-10-14',source:entry.source},'the entry fields of the console answer');
check(osSupportDaysLeft('2025-10-14',end-day),1,'days left helper');
check(osSupportStatus(snapshot('Professional','19045'),entry,null,end-100*day,90).status,'supported','a warning step of 90 days');
check([osSupportWarningDays(defaultAlertSettings()),osSupportWarningDays({...defaultAlertSettings(),'os-support-end':{enabled:true,warning:30,critical:0,level:null}}),osSupportWarningDays({...defaultAlertSettings(),'os-support-end':{enabled:false,warning:30,critical:0,level:null}}),osSupportWarningDays({...defaultAlertSettings(),'os-support-end':{enabled:true,warning:null,critical:0,level:null}})],[180,30,180,180],'the effective warning step, 180 when off or without warning');

// ---- ESU ----
const device='d1',groups=[{id:'outer',name:'Outer',depth:0},{id:'inner',name:'Inner',depth:1}];
const rows=[{scopeType:'group',scopeId:'outer',until:'2026-10-13',updatedAt:1},{scopeType:'group',scopeId:'inner',until:'2027-10-12',updatedAt:1},{scopeType:'device',scopeId:'d1',until:'2028-10-10',updatedAt:1}];
check(resolveEsu(device,groups,rows),{until:'2028-10-10',origin:{type:'device',id:'d1',name:''}},'the device beats its groups');
check(resolveEsu(device,groups,rows.slice(0,2)),{until:'2027-10-12',origin:{type:'group',id:'inner',name:'Inner'}},'the inner group beats the outer group');
check(resolveEsu(device,[...groups].reverse(),rows.slice(0,1)),{until:'2026-10-13',origin:{type:'group',id:'outer',name:'Outer'}},'the outer group when only it has a date');
check(resolveEsu(device,groups,[]),null,'no ESU');
check(resolveEsu('d2',[],rows),null,'another device does not inherit');
const customerRow={scopeType:'customer',scopeId:'c1',until:'2029-01-09',updatedAt:1};
check(resolveEsu(device,groups,[...rows,customerRow],'c1').origin.type,'device','the device beats its customer');
check(resolveEsu(device,groups,[...rows.slice(0,2),customerRow],'c1').origin,{type:'group',id:'inner',name:'Inner'},'the closest group beats the customer');
check(resolveEsu(device,groups,[customerRow],'c1'),{until:'2029-01-09',origin:{type:'customer',id:'c1',name:''}},'the customer when no group and no device has a date');
check([resolveEsu(device,groups,[customerRow]),resolveEsu(device,groups,[customerRow],'c2')],[null,null],'without its customer id, or for another customer: null');
const viaCustomer=deviceOsSupport({id:'d1',groups,customerId:'c1',customerName:'Contoso',snapshot:snapshot('Professional','19045')},[customerRow],defaultAlertSettings(),end+10*day);
check(viaCustomer.esu,{until:'2029-01-09',origin:{type:'customer',id:'c1',name:'Contoso'}},'deviceOsSupport passes the customer id and names the customer origin');
check(effectiveSupportEnd('2027-01-12','2026-01-01'),'2027-01-12','an ESU earlier than the catalog end is ignored');
check(effectiveSupportEnd('2025-10-14','2026-10-13'),'2026-10-13','a later ESU moves the end');
const withEsu=osSupportStatus(snapshot('Professional','19045'),entry,{until:'2026-10-13',origin:{type:'group',id:'inner',name:'Inner'}},Date.parse('2026-10-13T00:00:00Z')-100*day,180);
check([withEsu.status,withEsu.effectiveEnd,withEsu.esu.until],['ending','2026-10-13','2026-10-13'],'ESU keeps an ended version ending, with its origin');
const viaConsole=deviceOsSupport({id:'d1',groups,snapshot:snapshot('Professional','19045')},rows.slice(0,2),defaultAlertSettings(),end+10*day);
check([viaConsole.status,viaConsole.esu.origin.id],['supported','inner'],'deviceOsSupport resolves the ESU of the closest group');

console.log(`PASS os support catalog (${checks} checks): schema, catalog age, Windows 10 and 11 (21H2–26H2), LTSC and Server 2016–2025 mapping, the 2026-11-04 check dates, status boundaries and ESU resolution.`);
