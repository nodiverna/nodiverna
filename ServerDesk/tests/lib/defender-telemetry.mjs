// The snapshot field defender of agent 4.14.0 (lib/server/agent/telemetry.ts defenderState,
// docs/v3-health-signals.md): a full report, a report without Defender and the
// sample devices pass; an unknown key, too many detections or exclusions,
// inconsistent totals, duplicate IDs and extra fields of a failed read reject
// the whole Heartbeat. The top-level key defenderScan of agent 4.15.0 (a portal
// scan that still runs) is strict as well, and the demo data with a running scan passes. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {telemetry,defenderState,defenderScanState}=await import('../../lib/server/agent/telemetry.ts');
const {demoData}=await import('../../ui/shell/demo.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const base={hostname:'H',os:'Windows Server 2025 Standard',build:'26100',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.14.0',mode:'ReadOnly',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:['defender-status']};
const at='2026-11-04T10:00:00.000Z';
const detection=(id,extra={})=>({id,threatId:'2147519003',name:'Virus:DOS/EICAR_Test_File',severity:'severe',status:'quarantined',active:false,path:'C:\\Users\\anna\\Downloads\\eicar.txt',resourceCount:1,at,user:'CONTOSO\\anna',...extra});
const full={available:true,collectedAt:at,mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:null,quickScanAt:at,fullScanAt:null,signatureAt:at,signatureVersion:'1.421.1234.0',productVersion:'4.18.24090.11',
 otherAntivirus:[{name:'Contoso Endpoint Security',enabled:false}],detectionCount:2,activeCount:1,highestActiveSeverity:'high',truncated:false,
 detections:[detection('{A}'),detection('{B}',{severity:'high',status:'detected',active:true,name:null,path:null,user:null,at:null,resourceCount:0})],
 exclusions:{paths:['C:\\Temp\\x'],extensions:['.log'],processes:[]}};
const valid=value=>defenderState.safeParse(value).success;

// ---- Accepted ----
check(telemetry.safeParse({...base,defender:full}).success,true,'a full report in a Heartbeat');
check(telemetry.safeParse({...base,agentVersion:'4.13.1',agentCapabilities:[]}).success,true,'a 4.13 snapshot without defender stays valid');
for(const reason of ['not-installed','access-denied','error'])check(valid({available:false,reason,collectedAt:at}),true,`not available: ${reason}`);
check(valid({available:false,collectedAt:at}),true,'not available without a reason');
check(valid({...full,otherAntivirus:null,exclusions:null,highestActiveSeverity:null,activeCount:1}),true,'Windows Server: no Security Center, unreadable exclusions');
for(const mode of ['passive','sxs-passive','edr-block','not-running','unknown'])check(valid({...full,mode}),true,`mode ${mode}`);
const many=Array.from({length:100},(_,index)=>detection('{D'+index+'}'));
check(valid({...full,detections:many,detectionCount:250,activeCount:1,truncated:true}),true,'100 of 250 detections, truncated, active ones outside the list');
check(valid({...full,exclusions:{paths:Array.from({length:200},(_,index)=>'C:\\P'+index),extensions:[],processes:['p'.repeat(500)]}}),true,'200 paths, 500 characters');
const servers=demoData().servers;
for(const server of servers){
 const value=server.snapshot.defender;
 if(value===undefined){check(server.snapshot.agentCapabilities.includes('defender-status'),false,`${server.name}: no report without the capability`);continue;}
 check(defenderState.safeParse(value).success,true,`${server.name}: the sample report passes`);
}
check(servers.filter(server=>server.snapshot.defender).length,3,'three sample devices report Defender');
// The sample paths, users and exclusions keep their backslashes (a single '\U' or '\t'
// in a source string would drop them or turn into a control character).
{
 const reports=servers.map(server=>server.snapshot.defender).filter(value=>value?.available);
 const detections=reports.flatMap(value=>value.detections??[]);
 const exclusions=reports.flatMap(value=>value.exclusions?[...value.exclusions.paths,...value.exclusions.extensions,...value.exclusions.processes]:[]);
 const texts=[...detections.flatMap(item=>[item.path,item.user]),...exclusions].filter(text=>typeof text==='string');
 check(texts.filter(text=>/[\u0000-\u001f\u007f]/.test(text)),[],'no sample path, user or exclusion holds a control character');
 check(detections.every(item=>item.path===null||/^[A-Z]:\\[^\\]/.test(item.path)),true,'every sample detection path starts with a drive and a backslash');
 check(detections.find(item=>item.name==='Trojan:Win32/Wacatac.B!ml')?.path,'C:\\Users\\demo.user\\Downloads\\invoice-2026.pdf.exe','the sample detection path keeps its backslashes');
 check(detections.find(item=>item.name==='Trojan:Win32/Wacatac.B!ml')?.user,'CONTOSO\\demo.user','the sample user is CONTOSO\\demo.user');
 check(exclusions.filter(text=>text.startsWith('D:')||text.startsWith('C:')),['D:\\SQLData','D:\\SQLLogs','C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Backup'],'the SQL exclusion paths keep their backslashes');
}

// ---- Rejected ----
const rejects=[
 ['an unknown key',{...full,recoveryKey:'x'}],
 ['an unknown detection key',{...full,detections:[{...detection('{A}'),hash:'x'}],detectionCount:1,activeCount:0}],
 ['an unknown exclusion key',{...full,exclusions:{...full.exclusions,ports:[]}}],
 ['an unknown product key',{...full,otherAntivirus:[{name:'X',enabled:true,path:'C:\\x'}]}],
 ['101 detections',{...full,detections:Array.from({length:101},(_,index)=>detection('{E'+index+'}')),detectionCount:101,activeCount:0}],
 ['201 paths',{...full,exclusions:{paths:Array.from({length:201},(_,index)=>'C:\\P'+index),extensions:[],processes:[]}}],
 ['a path of 501 characters',{...full,exclusions:{paths:['p'.repeat(501)],extensions:[],processes:[]}}],
 ['5 other products',{...full,otherAntivirus:Array.from({length:5},(_,index)=>({name:'AV'+index,enabled:true}))}],
 ['a product name of 257 characters',{...full,otherAntivirus:[{name:'n'.repeat(257),enabled:true}]}],
 ['a version of 65 characters',{...full,productVersion:'1'.repeat(65)}],
 ['detectionCount below the list',{...full,detectionCount:1}],
 ['truncated without more detections',{...full,truncated:true}],
 ['not truncated with more detections',{...full,detectionCount:3}],
 ['activeCount below the active rows',{...full,activeCount:0}],
 ['duplicate detection IDs',{...full,detections:[detection('{A}'),detection('{A}')],activeCount:0}],
 ['an unknown severity',{...full,highestActiveSeverity:'critical'}],
 ['an unknown status',{...full,detections:[detection('{A}',{status:'deleted'})],detectionCount:1,activeCount:0}],
 ['a date without zone',{...full,quickScanAt:'2026-11-04 10:00'}],
 ['extra fields when not available',{available:false,reason:'error',collectedAt:at,mode:'normal'}],
 ['detections when not available',{available:false,reason:'not-installed',collectedAt:at,detections:[]}],
 ['an unknown reason',{available:false,reason:'not-supported',collectedAt:at}],
 ['a report without exclusions',Object.fromEntries(Object.entries(full).filter(([key])=>key!=='exclusions'))],
];
for(const [label,value] of rejects){
 check(valid(value),false,`rejects ${label}`);
 check(telemetry.safeParse({...base,defender:value}).success,false,`the Heartbeat with ${label} is rejected`);
}

// ---- defenderScan of agent 4.15.0 ----
for(const kind of ['quick','full'])check(telemetry.safeParse({...base,defender:full,defenderScan:{kind,startedAt:at}}).success,true,`a running ${kind} scan`);
check(telemetry.safeParse({...base,defender:full,defenderScan:{kind:'quick',startedAt:'2026-11-04T10:00:00.0000000+00:00'}}).success,true,'the agent time format with offset');
check(telemetry.safeParse({...base,defender:full}).data.defenderScan,undefined,'without a portal scan the key is absent');
for(const [label,value] of [['an extra key',{kind:'quick',startedAt:at,progress:40}],['a bad kind',{kind:'custom',startedAt:at}],['no start',{kind:'full'}],['a date without zone',{kind:'quick',startedAt:'2026-11-04 10:00'}]]){
 check(defenderScanState.safeParse(value).success,false,`defenderScan rejects ${label}`);
 check(telemetry.safeParse({...base,defender:full,defenderScan:value}).success,false,`the Heartbeat with defenderScan of ${label} is rejected`);
}
const sample=demoData().servers.find(server=>server.snapshot?.defenderScan);
check([sample?.name,sample?.snapshot.defenderScan.kind],['SRV-SQL01','quick'],'one sample device runs a quick scan');
check([defenderScanState.safeParse(sample.snapshot.defenderScan).success,telemetry.safeParse({...base,defender:sample.snapshot.defender,defenderScan:sample.snapshot.defenderScan}).success],[true,true],'the sample running scan passes the schema, also in a Heartbeat');

console.log(`PASS defender telemetry (${checks} checks): full, not available and sample reports pass; unknown keys, the 100/200/4 limits, text lengths, inconsistent totals, duplicate IDs and extra fields of a failed read reject the Heartbeat; defenderScan is accepted for quick and full and rejected with an extra key or a bad kind.`);
