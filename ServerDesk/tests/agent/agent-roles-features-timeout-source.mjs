// Static checks of agent 4.21.5 (roles and features timeout): "Roles and features"
// runs with NativeFeatures.InventoryDeadlineSeconds instead of 25 s, the
// ServerManager enumeration uses ServerEnumerationSeconds, the broker joins a
// running read instead of failing after 30 s, the role list is single-flight,
// the broker logs a role timing line, the self-tests are registered and the
// release files name 4.21.5. Comments are stripped; no build.
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
// Code without comments, so that a comment that names a removed call does not count.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/\/\/.*$/,'')).join('\n');
const telemetry=code('agent/v3/NativeTelemetry.cs'),features=code('agent/v3/NativeFeatures.cs'),broker=code('agent/v3/AgentBroker.cs');
const featureTests=code('agent/v3/NativeFeaturesProviderTests.cs'),brokerTests=code('agent/v3/BrokerSelfTests.cs'),failureTests=code('agent/v3/AgentFailurePathTests.cs');

// ---- the time budget ----
const roles=telemetry.split('\n').find(line=>line.includes('Add("Roles and features"'));
ok(roles,'NativeTelemetry registers "Roles and features"');
ok(/,\s*NativeFeatures\.InventoryDeadlineSeconds\);\s*$/.test(roles)&&/Add\("Roles and features",\s*InventorySeconds,/.test(roles),'"Roles and features" runs every InventorySeconds with NativeFeatures.InventoryDeadlineSeconds');
ok(!/,\s*25\)\s*;/.test(roles),'the old 25 s deadline is gone');
ok(/internal const int ServerEnumerationSeconds = 120;/.test(features)&&/internal const int InventoryDeadlineSeconds = 150;/.test(features),'NativeFeatures defines ServerEnumerationSeconds = 120 and InventoryDeadlineSeconds = 150');
const enumerate=features.slice(features.indexOf('EnumerateServer(ManagementClass'),features.indexOf('private static JsonArray ServerList'));
ok(/DateTime\.UtcNow\.AddSeconds\(ServerEnumerationSeconds\)/.test(enumerate)&&!features.includes('AddMinutes(2)'),'EnumerateServer polls for ServerEnumerationSeconds, not a literal 2 minutes');

// ---- the broker joins a running read ----
const brokerTelemetry=broker.slice(broker.indexOf('internal sealed class BrokerTelemetry'));
ok(brokerTelemetry.length>0&&!broker.includes('The privileged inventory is still running'),'the broker never fails a waiting read with "still running"');
ok(!brokerTelemetry.includes('WaitAsync(TimeSpan.FromSeconds(30)'),'BrokerTelemetry has no fixed 30 s gate wait');
ok(/running\.TryGetValue\(name, out run!\)/.test(brokerTelemetry)&&/await run\.WaitAsync\(token\)/.test(brokerTelemetry),'a request joins the running read of its name and only its own token ends the wait');
ok(/owner\.SetException\(error\)/.test(brokerTelemetry)&&(brokerTelemetry.match(/running\.Remove\(name\)/g)??[]).length===2,'a run ends its flight on success and on failure and gives a failure to every waiter');
ok(/Func<string, JsonObject>\? collect = null/.test(brokerTelemetry),'BrokerTelemetry has an injectable collect delegate for the self-test');
ok(/"Roles and features" => Roles\(\)/.test(brokerTelemetry)&&/rolesTiming\.LogLine\(watch\.ElapsedMilliseconds, features\.Count\) is string line\) log\?\.Invoke\(line\)/.test(brokerTelemetry),'the "Roles and features" branch logs a timing line');
ok(/internal static string FailureLine\(string name, Exception error, long elapsedMs, Func<string, string> redact\)/.test(broker),'the broker failure line keeps its signature');

// ---- one shared role enumeration ----
ok(/flights\.TryGetValue\(server, out run!\)/.test(features)&&/await run\.WaitAsync\(token\)/.test(features),'a list call joins the running enumeration');
ok(/await Gate\.WaitAsync\(\);/.test(features)&&/Task\.Run\(\(\) => enumerate\(server\)\)/.test(features),'the shared enumeration waits for Gate without a caller token');
ok(/finally \{ lock \(Flight\) cached = null; DismDisplayNames\.Clear\(\); Gate\.Release\(\); \}/.test(features),'a change still clears the cache and the DISM display names');
ok(/"Broker telemetry Roles and features: read in \{elapsedMs\} ms \(\{components\} components\)\."/.test(features),'the timing line format');
ok(/internal const int TimingLogMilliseconds = 20_000;/.test(features),'a read of 20 s or more logs again');

// ---- the self-tests ----
ok(/Budget\(Assert\);/.test(featureTests)&&/ListSingleFlightAsync\(Assert\)/.test(featureTests)&&/Timing\(Assert\);/.test(featureTests),'NativeFeaturesProviderTests.Run runs the budget, single-flight and timing cases');
ok(/await TelemetrySingleFlightAsync\(\);/.test(brokerTests)&&/new BrokerTelemetry\(Path\.GetTempPath\(\), null, Collect\)/.test(brokerTests),'BrokerSelfTests runs the joined-read case with an injected collect');
ok(/await RolesAsync\(\);/.test(failureTests),'AgentFailurePathTests runs the role slot case');
ok(/NativeFeaturesProviderTests\.Run\(\)/.test(read('agent/v3/SelfTests.cs'))&&/NativeFeaturesProviderTests\.Run\(\)/.test(read('agent/v3/NativeFeaturesAbiTests.cs')),'the feature provider tests run in --self-test and --features-self-test');

// ---- release 4.21.5 ----
ok(read('agent/v3/Program.cs').includes('BaseVersion = "4.21.5"'),'Program.BaseVersion is 4.21.5');
ok(read('agent/v3/ServerDesk.Agent.csproj').includes('<Version>4.21.5</Version>'),'the csproj version is 4.21.5');
const readme=read('agent/v3/README.md');
ok(readme.startsWith('# ServerDesk native agent 4.21.5')&&readme.includes('are `4.21.5`')&&readme.includes('Since 4.21.5, '),'the README names 4.21.5');
ok(existsSync('agent/v3/changelogs/4.21.5.json'),'the 4.21.5 changelog exists');
const changelog=JSON.parse(read('agent/v3/changelogs/4.21.5.json'));
ok(changelog.version==='4.21.5'&&changelog.features.length===0&&changelog.fixes.length===1,'the changelog has one fix and no features');
ok(JSON.parse(read('lib/agent-changelog-history.json')).some(entry=>entry.version==='4.21.5'),'the history has the 4.21.5 entry');
const docs=read('docs/native-agent-v4.md');
ok(docs.startsWith('# ServerDesk native agent 4.21.5')&&docs.includes('## Fixes in 4.21.5'),'docs/native-agent-v4.md has the 4.21.5 title and fixes');

console.log(`agent roles and features timeout source: ${checks} checks passed.`);
