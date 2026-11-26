// The heartbeat schema (lib/server/agent/telemetry.ts) for agent health: reboot causes, cleanup metadata, older agents,
// bounds, agentIntegrity and plugin reports.
import '../support/register.mjs';
import assert from 'node:assert/strict';

const {telemetry}=await import('../../lib/server/agent/telemetry.ts');
const snapshot={hostname:'HEALTH-TEST',os:'Windows 11 Pro',build:'26100',manufacturer:'Example',model:'PC',domain:'WORKGROUP',cores:4,memoryGb:16,cpu:1,memory:20,uptimeSeconds:3600,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.6.3',mode:'Management',publicKey:{kty:'RSA',n:'A'.repeat(342),e:'AQAB'},agentCapabilities:['refresh']};

assert.ok(telemetry.safeParse(snapshot).success,'older agents remain compatible without cause fields');
let parsed=telemetry.parse({...snapshot,rebootReasons:[],pendingFileOperationsCount:2});
assert.equal(parsed.rebootPending,false);assert.deepEqual(parsed.rebootReasons,[]);assert.equal(parsed.pendingFileOperationsCount,2,'neutral cleanup metadata survives heartbeat validation');
for(const reason of ['windows-servicing','windows-update','file-replacement','file-operations-unknown']){
 parsed=telemetry.parse({...snapshot,rebootPending:true,rebootReasons:[reason],pendingFileOperationsCount:0});
 assert.deepEqual(parsed.rebootReasons,[reason],'confirmed and conservative causes remain explicit');
}
for(const changes of [
 {rebootPending:false,rebootReasons:['windows-update']},{rebootPending:true,rebootReasons:[]},
 {rebootPending:true,rebootReasons:['windows-update','windows-update']},{rebootPending:true,rebootReasons:['unknown-source']},
 {rebootPending:true,rebootReasons:Array(5).fill('windows-update')},{rebootReasons:null},
 ...[-1,1.5,1_000_001,Infinity,'2',null].map(pendingFileOperationsCount=>({pendingFileOperationsCount}))
])assert.equal(telemetry.safeParse({...snapshot,...changes}).success,false,'inconsistent or unbounded reboot metadata is rejected');
assert.ok(telemetry.safeParse({...snapshot,rebootPending:true,rebootReasons:['windows-servicing','windows-update','file-replacement','file-operations-unknown'],pendingFileOperationsCount:1_000_000}).success,'full bounded cause set remains valid');
// osInfo of agent 4.10.0: strict, strings up to 100 characters, UBR a whole number; a 4.9.x snapshot without it stays valid.
const osInfo={editionId:'Professional',installationType:'Client',displayVersion:'24H2',ubr:6899,productName:'Windows 10 Pro',currentBuild:'26100'};
assert.ok(telemetry.safeParse({...snapshot,agentVersion:'4.9.0'}).success,'a 4.9.x snapshot without the health signal fields stays valid');
assert.deepEqual(telemetry.parse({...snapshot,agentVersion:'4.10.0',osInfo}).osInfo,osInfo,'osInfo is kept');
assert.ok(telemetry.safeParse({...snapshot,osInfo:{editionId:null,installationType:null,displayVersion:null,ubr:null,productName:null,currentBuild:null}}).success,'missing values are null');
for(const change of [{editionId:'x'.repeat(101)},{ubr:1.5},{ubr:-1},{currentBuild:26100},{secret:'x'}])assert.equal(telemetry.safeParse({...snapshot,osInfo:{...osInfo,...change}}).success,false,'osInfo is strict and bounded: '+JSON.stringify(change).slice(0,40));
assert.equal(telemetry.safeParse({...snapshot,osInfo:{editionId:'Core'}}).success,false,'every osInfo key is required');
assert.ok(telemetry.safeParse({...snapshot,softwareChecksum:null}).success&&telemetry.safeParse({...snapshot,softwareChecksum:'a'.repeat(64)}).success,'the software checksum is null or 64 hex digits');
assert.equal(telemetry.safeParse({...snapshot,softwareChecksum:'A'.repeat(64)}).success,false,'upper-case hex is rejected');
// agentIntegrity of agent 4.18.0: strict and optional; at most 2 services and 16 findings, the contract enums only.
const integrity={checkedAt:'2026-11-09T08:00:00.000Z',services:[{service:'broker',startType:'delayed-auto'},{service:'worker',startType:'disabled'}],findings:[{target:'service-dacl',service:'worker'},{target:'folder-agent'}]};
assert.deepEqual(telemetry.parse({...snapshot,agentVersion:'4.18.0',agentIntegrity:integrity}).agentIntegrity,integrity,'agentIntegrity is kept');
assert.ok(telemetry.safeParse({...snapshot,agentVersion:'4.17.0'}).success,'a snapshot without agentIntegrity (older agent) stays valid');
for(const [label,change] of [['an unknown key',{secret:'x'}],['an unknown start type',{services:[{service:'worker',startType:'boot'}]}],['an unknown service',{services:[{service:'updater',startType:'auto'}]}],['three services',{services:Array(3).fill({service:'broker',startType:'auto'})}],
 ['an unknown target',{findings:[{target:'registry'}]}],['17 findings',{findings:Array(17).fill({target:'folder-agent'})}],['a finding with a text',{findings:[{target:'folder-agent',finding:'owner'}]}],['a checkedAt that is no time',{checkedAt:'yesterday'}]])
 assert.equal(telemetry.safeParse({...snapshot,agentIntegrity:{...integrity,...change}}).success,false,'agentIntegrity is strict and bounded: '+label);
assert.equal(telemetry.safeParse({...snapshot,agentIntegrity:{checkedAt:integrity.checkedAt,services:[]}}).success,false,'every agentIntegrity key is required');
// Plugin reports (docs/agent-plugins.md): current agents send role, a later agent may send target; the parsed report has target only.
{
 const {pluginReportTarget}=await import('../../lib/plugin-catalog.ts');
 const report={name:'dhcp',version:'1.1.1',capabilities:['dhcp-read'],state:'ready',networkBlocked:true};
 const parse=plugins=>telemetry.safeParse({...snapshot,plugins});
 for(const [label,extra,target] of [['role only',{role:'dhcp'},'dhcp'],['target only',{target:'dhcp'},'dhcp'],['both, target wins',{role:'dhcp',target:'dns'},'dns'],['a damaged plugin with role unknown',{role:'unknown'},'unknown']]){
  const result=parse([{...report,...extra}]);
  assert.ok(result.success,'plugin report with '+label);
  assert.deepEqual(result.data.plugins,[{...report,target}],'plugin report with '+label+': target, no role');
 }
 for(const [label,extra] of [['neither target nor role',{}],['an invalid target',{target:'DHCP'}],['an invalid role',{role:'x'}],['an unknown key',{role:'dhcp',kind:'plugin'}]])
  assert.equal(parse([{...report,...extra}]).success,false,'plugin report refused: '+label);
 assert.equal(parse([{...report,role:'dhcp'},{...report,target:'dhcp'}]).success,false,'plugin names stay unique');
 assert.deepEqual([pluginReportTarget({name:'dhcp',role:'dhcp'}),pluginReportTarget({name:'dhcp',target:'dns',role:'dhcp'}),pluginReportTarget({name:'dhcp'})],['dhcp','dns',null],'pluginReportTarget: target, else the role of an older stored report, else null');
}
console.log('PASS: agent health telemetry retains neutral cleanup and concrete reboot causes, accepts older agents, rejects inconsistent or unbounded metadata, accepts the strict agentIntegrity of 4.18.0, and parses plugin reports with role or target into target.');
