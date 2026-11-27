// Static checks of the Windows license collector of agent 4.22.0
// (agent/v3/NativeWindowsLicense.cs): the exact select list and the Windows
// application ID, no key property in a select list and none named outside the
// PartialProductKey filter, no method call on a licensing class, the collector
// in PrivilegedProviders and as a fixed case of the broker switch, interval
// 3600 s and deadline 30 s, the self-test in Program.cs and the agent build, and
// the release 4.22.0 with its changelog. No build.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
// Code without comments, so that a comment that names a forbidden word does not count.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/\/\/.*$/,'')).join('\n');
const source=code('agent/v3/NativeWindowsLicense.cs'),telemetry=read('agent/v3/NativeTelemetry.cs'),broker=read('agent/v3/AgentBroker.cs'),program=read('agent/v3/Program.cs'),build=read('scripts/build-agent-v3.mjs');

// ---- The query ----
ok(source.includes('internal const string FullQuery = "SELECT Description, LicenseFamily, ProductKeyChannel, LicenseStatus, GracePeriodRemaining, EvaluationEndDate" + Filter;'),'the full select list is exactly the six properties');
ok(source.includes('internal const string ShortQuery = "SELECT Description, LicenseFamily, LicenseStatus, GracePeriodRemaining" + Filter;'),'the fallback select list leaves out ProductKeyChannel and EvaluationEndDate');
ok(source.includes('private const string Filter = " FROM SoftwareLicensingProduct WHERE ApplicationID = \'" + NativeWindowsLicense.WindowsApplicationId + "\' AND PartialProductKey IS NOT NULL";'),'only Windows rows with an installed key');
ok(source.includes('internal const string WindowsApplicationId = "55c92734-d682-4d71-983e-d6ec3f16059f";'),'the Windows application ID');
ok(/Query\(@"root\\cimv2", full \? FullQuery : ShortQuery, 32, Timeout\)/.test(source),'one read-only WQL query in root\\cimv2');
ok(/catch \(WindowsLicensePropertyException\) \{ rows = source\.Rows\(full: false\); \}/.test(source),'a refused full query is repeated without the two properties');
ok(/ManagementStatus\.InvalidQuery or ManagementStatus\.InvalidProperty/.test(source),'an unknown property is the reason for the second query');

// ---- No product key, read only ----
const selects=[...source.matchAll(/"SELECT ([^"]+)"/g)].map(match=>match[1]);
ok(selects.length===2,'two select lists');
for(const property of ['PartialProductKey','ProductKeyID','ProductKeyID2','OfflineInstallationId','OA3xOriginalProductKey','BackupProductKeyDefault'])
 ok(selects.every(list=>!list.includes(property)),`no select list names ${property}`);
for(const property of ['ProductKeyID','OfflineInstallationId','OA3xOriginalProductKey','BackupProductKeyDefault'])ok(!source.includes(property),`the source never names ${property}`);
ok((source.match(/PartialProductKey/g)??[]).length===1&&source.includes('PartialProductKey IS NOT NULL'),'PartialProductKey appears only in the filter');
for(const forbidden of ['Invoke(','InvokeMethod','ExecMethod','Activate','InstallProductKey','UninstallProductKey','ReArm','RefreshLicenseStatus','SetKeyManagementServiceMachine','Put(','Delete(','CreateInstance','SetPropertyValue','PowerShell','Process.Start','slmgr'])
 ok(!source.includes(forbidden),`the collector never uses ${forbidden}`);
ok(!/\bRegistry\.\w+/.test(source),'no registry access');

// ---- Collector, broker, interval and deadline ----
ok(/PrivilegedProviders = \[[^\]]*"Windows license"/.test(telemetry),'Windows license is a privileged provider');
ok(/Add\("Windows license", NativeWindowsLicense\.IntervalSeconds, new NativeWindowsLicense\(\)\.Collect, NativeWindowsLicense\.DeadlineSeconds\)/.test(telemetry),'the collector has its own interval and deadline');
ok(/"Windows license" => windowsLicense\.Collect\(\),/.test(broker)&&/private readonly NativeWindowsLicense windowsLicense = new\(\);/.test(broker),'a fixed, argument-free case of the broker switch');
ok(/internal const int IntervalSeconds = 3600;/.test(source)&&/internal const int DeadlineSeconds = 30;/.test(source),'interval 3600 s, deadline 30 s');
ok(/\["windowsLicense"\] = new JsonObject/.test(source),'the snapshot key is windowsLicense');
for(const reason of ['not-found','access-denied','error'])ok(source.includes(`Unavailable("${reason}")`),`the reason ${reason}`);

// ---- Self-test and release ----
ok(program.includes('args[0] == "--windows-license-self-test") return NativeWindowsLicenseTests.RunSelfTest();'),'the self-test is registered in Program.cs');
ok(build.includes("'--windows-license-self-test'"),'the agent build runs the self-test');
ok(existsSync('agent/v3/NativeWindowsLicenseTests.cs'),'the self-test source exists');
const version=/internal const string BaseVersion = "(\d+)\.(\d+)\.(\d+)";/.exec(program),current=version?version.slice(1).join('.'):'';
ok(!!version&&(Number(version[1])>4||Number(version[1])===4&&Number(version[2])>=22),`Program.Version is 4.22.0 or later (${current})`);
ok(read('agent/v3/ServerDesk.Agent.csproj').includes(`<Version>${current}</Version>`),'the csproj has the same version');
const changelog=JSON.parse(read('agent/v3/changelogs/4.22.0.json'));
ok(changelog.version==='4.22.0'&&changelog.features.length===1&&/Windows is activated/.test(changelog.features[0])&&changelog.fixes.length===0,'changelogs/4.22.0.json has the one feature line');
ok(JSON.parse(read('lib/agent-changelog-history.json')).some(entry=>entry.version==='4.22.0'),'the changelog history has 4.22.0');

console.log(`PASS agent Windows license source (${checks} checks): the exact select lists and the Windows application ID, no key property and no method call, a privileged broker read every 3600 s with a 30 s deadline, the registered self-test and release 4.22.0.`);
