// The contract between the DNS plugin and the portal. The plugin's
// self-test (agent/plugins/dns/DnsSelfTests.cs, ContractAsync) runs a realistic
// server read, a zone read with records of every type and an empty zone read
// through its protocol session, the agent's ReadResult and the shared upload
// envelope, and requires the uploaded data to equal the JSON documents between
// the dns-contract markers. This test reads the same documents and parses them
// with the portal's schemas (lib/dns.ts), so the plugin output and the portal
// cannot drift apart without a failing check on every CI run. It also pins the
// agent side of the fix statically: ReadResult hands out data without a parent,
// the broker builds its upload through the shared builder, and a failed upload
// of a plugin job has its own code.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {dnsSnapshotSchema,dnsZoneRecordsSchema,dnsZoneSummary,dnsKpis,dnsFleetRows,dnsZones}=await import('../../lib/dns.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---- The documents of the plugin's self-test ------------------------------------------------------
const source=await readFile('agent/plugins/dns/DnsSelfTests.cs','utf8');
const contracts=new Map();
for(const [,name,body] of source.matchAll(/\/\/ dns-contract:([a-z]+):start\r?\n([\s\S]*?)\/\/ dns-contract:\1:end/g)){
 const open=body.indexOf('"""'),close=body.lastIndexOf('"""');
 assert.ok(open>=0&&close>open,`dns-contract:${name} holds a raw string literal`);
 contracts.set(name,JSON.parse(body.slice(open+3,close)));
}
check([...contracts.keys()].sort(),['empty','records','server'],'three contract documents: the server read, a zone with records and an empty zone');
check(/await ContractAsync\(\);/.test(source),true,'the self-test runs the contract case');
check(/Check\(actual == JsonNode\.Parse\(expected\)!\.ToJsonString\(\)/.test(source),true,'the self-test compares the uploaded data with the documents');

// ---- The server read --------------------------------------------------------------------------------
const server=dnsSnapshotSchema.safeParse(contracts.get('server'));
assert.ok(server.success,`the server read passes dnsSnapshotSchema: ${JSON.stringify(server.error?.issues?.slice(0,5))}`);checks++;
const snapshot=server.data;
check(snapshot.zones.length>=7,true,'at least 7 zones');
const kinds=new Set(snapshot.zones.map(zone=>`${zone.kind}/${zone.lookup}/${zone.storage}`));
for(const kind of ['primary/forward/ad','primary/forward/file','primary/reverse/ad','secondary/forward/file','stub/forward/ad','forwarder/forward/file'])check(kinds.has(kind),true,`a ${kind} zone`);
check(snapshot.zones.some(zone=>zone.name.endsWith('.in-addr.arpa')&&!zone.autoCreated)&&snapshot.zones.some(zone=>zone.name.endsWith('.ip6.arpa')),true,'an IPv4 and an IPv6 reverse zone');
check(snapshot.zones.filter(zone=>zone.autoCreated).map(zone=>zone.name),['0.in-addr.arpa','127.in-addr.arpa','255.in-addr.arpa'],'the zones Windows creates itself');
check(snapshot.zones.some(zone=>zone.name===''||zone.name==='.'),false,'the cache zone is not listed');
check(snapshot.zones.map(zone=>zone.name),[...snapshot.zones.map(zone=>zone.name)].sort(),'the zones in name order');
const summary=dnsZoneSummary(snapshot);
check(summary.length,snapshot.zones.length,'dnsZoneSummary runs on it');
check(dnsFleetRows('srv',summary,Date.parse(snapshot.collectedAt)).length,summary.filter(zone=>!zone.autoCreated).length,'dnsFleetRows keeps the zones Windows did not create');
const kpis=dnsKpis(snapshot);
check([kpis.zones,kpis.forwarders,kpis.scavenging,kpis.useRootHints],[dnsZones(snapshot).length,2,true,true],'dnsKpis runs on it');

// ---- The zone read with records --------------------------------------------------------------------
const zone=dnsZoneRecordsSchema.safeParse(contracts.get('records'));
assert.ok(zone.success,`the zone read passes dnsZoneRecordsSchema: ${JSON.stringify(zone.error?.issues?.slice(0,5))}`);checks++;
const types=new Set(zone.data.records.map(record=>record.type));
check(types.size>=10,true,'records of at least 10 types');
for(const type of ['SOA','NS','A','AAAA','CNAME','MX','TXT','SRV','PTR'])check(types.has(type),true,`a ${type} record`);
check(zone.data.records.find(record=>record.type==='TXT')?.data.strings.length,2,'a TXT record with two strings');
check(zone.data.records.filter(record=>!['SOA','NS','A','AAAA','CNAME','MX','TXT','SRV','PTR'].includes(record.type)).map(record=>[record.type,record.data]),[['HINFO',{}]],'an unknown type keeps {} and its text');
check([zone.data.total,zone.data.truncated],[zone.data.records.length,false],'total and truncated');
check(zone.data.zone,'corp.example','the zone of the read');
check(snapshot.zones.some(item=>item.name===zone.data.zone),true,'the zone is in the server read');

// ---- The empty zone ----------------------------------------------------------------------------------
const empty=dnsZoneRecordsSchema.safeParse(contracts.get('empty'));
assert.ok(empty.success,`the empty zone read passes dnsZoneRecordsSchema: ${JSON.stringify(empty.error?.issues?.slice(0,5))}`);checks++;
check([empty.data.records,empty.data.total,empty.data.truncated],[[],0,false],'an empty zone read');
check(snapshot.zones.some(item=>item.name===empty.data.zone&&item.kind!=='forwarder'),true,'the empty zone is a readable zone of the server read');

// ---- The agent side, statically -------------------------------------------------------------------
const protocol=await readFile('agent/plugins/shared/PluginProtocol.cs','utf8'),broker=await readFile('agent/v3/AgentBroker.cs','utf8'),host=await readFile('agent/v3/PluginHost.cs','utf8');
const readResult=protocol.slice(protocol.indexOf('internal static PluginResult ReadResult('),protocol.indexOf('internal static JsonObject UploadMessage('));
check(/data = payload;/.test(readResult),false,'ReadResult no longer hands out the node of the result line');
check(/data = payload\.DeepClone\(\)\.AsObject\(\);/.test(readResult),true,'ReadResult hands out a copy without a parent');
check(/internal static JsonObject UploadMessage\(PluginUpload upload\)/.test(protocol)&&/upload\.Data\.Parent is null \? upload\.Data : upload\.Data\.DeepClone\(\)/.test(protocol),true,'the shared envelope builder copies data that have a parent');
check(/relay\.CallAsync\(PluginProtocol\.UploadMessage\(upload\)/.test(broker)&&!/\["kind"\] = "plugin-data-upload"/.test(broker),true,'the broker builds the upload envelope through the shared builder');
const runJob=host.slice(host.indexOf('internal async Task<JsonObject> RunJobAsync('),host.indexOf('internal static bool ReadOperation('));
check(/new AgentMessageException\(e, "AGENT_PLUGIN_UPLOAD_FAILED"\)/.test(runJob)&&/new AgentMessageException\(e, "AGENT_PLUGIN_FAILED"\)/.test(runJob),true,'RunJobAsync maps a failed upload to AGENT_PLUGIN_UPLOAD_FAILED and any other uncoded failure to AGENT_PLUGIN_FAILED');

console.log(`PASS DNS plugin contract (${checks} checks): the server read (${snapshot.zones.length} zones), the zone read (${zone.data.records.length} records of ${types.size} types) and the empty zone of the plugin self-test pass the portal schemas, the summary, the fleet rows and the KPIs; ReadResult copies the data, the broker uses the shared envelope, and plugin-job failures have codes.`);
