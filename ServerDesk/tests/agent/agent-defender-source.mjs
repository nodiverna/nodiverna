// Static checks of the Defender collector of agent 4.14.0 (agent/v3/NativeDefender.cs):
// a fixed privileged broker read with its own interval and deadline, only the
// five named WMI classes, no write call of any kind, the capability
// defender-status, the registered self-test and the release 4.14.0. No build.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
// Code without comments, so that a comment that names a forbidden call does not count.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/\/\/.*$/,'')).join('\n');
const source=code('agent/v3/NativeDefender.cs'),telemetry=read('agent/v3/NativeTelemetry.cs'),broker=read('agent/v3/AgentBroker.cs'),worker=code('agent/v3/AgentWorker.cs'),program=read('agent/v3/Program.cs'),build=read('scripts/build-agent-v3.mjs');

// ---- Provider, broker, interval and deadline ----
ok(/PrivilegedProviders = \[[^\]]*"Defender"/.test(telemetry),'Defender is a privileged provider');
ok(/"Defender" => defender\.Collect\(\),/.test(broker)&&/private readonly NativeDefender defender = new\(\);/.test(broker),'Defender is a fixed, argument-free case of the broker switch');
ok(/Add\("Defender", NativeDefender\.IntervalSeconds, new NativeDefender\(\)\.Collect, NativeDefender\.DeadlineSeconds\)/.test(telemetry),'Defender has its own interval and deadline');
ok(/internal const int IntervalSeconds = 300;/.test(source)&&/internal const int DeadlineSeconds = 20;/.test(source),'interval 300 s, deadline 20 s');
ok(/\["defender"\] = defender/.test(source)&&/\["defender"\] = new JsonObject \{ \["available"\] = false/.test(source),'the top-level snapshot key is defender');
ok(/\["security"\] = new JsonObject \{[^}]*\["defender"\] = defender, \["lastBoot"\]/.test(telemetry)&&/SELECT AntivirusEnabled,AntivirusSignatureLastUpdated,RealTimeProtectionEnabled FROM MSFT_MpComputerStatus/.test(telemetry),'security.defender stays in the Security collector');

// ---- Only the five classes, only reads ----
const classes=[...source.matchAll(/FROM (\w+)/g)].map(match=>match[1]);
ok(classes.length>=5&&classes.every(name=>['MSFT_MpComputerStatus','MSFT_MpThreatDetection','MSFT_MpThreat','MSFT_MpPreference','AntiVirusProduct'].includes(name)),`the source queries only the five classes (${[...new Set(classes)].join(', ')})`);
for(const name of ['MSFT_MpComputerStatus','MSFT_MpThreatDetection','MSFT_MpThreat','MSFT_MpPreference','AntiVirusProduct'])ok(classes.includes(name),`${name} is read`);
ok(/@"root\\Microsoft\\Windows\\Defender"/.test(source)&&/@"root\\SecurityCenter2"/.test(source),'the Defender and Security Center namespaces');
for(const forbidden of ['ExecMethod','InvokeMethod','Invoke(','Set-MpPreference','Add-MpPreference','Remove-MpPreference','Remove-MpThreat','Start-MpScan','Update-MpSignature','PowerShell','Put(','Delete(','CreateInstance','SetPropertyValue','Process.Start','ProcessStartInfo','MpCmdRun'])
 ok(!source.includes(forbidden),`the collector never uses ${forbidden}`);
ok(!/\bRegistry\.\w+\.(?:CreateSubKey|SetValue|DeleteValue|DeleteSubKey)/.test(source),'no registry write');

// ---- Capability, self-test, release ----
ok(/"defender-status"/.test(worker),'agentCapabilities contains defender-status');
ok(program.includes('args[0] == "--defender-self-test") return NativeDefenderTests.RunSelfTest();'),'NativeDefenderTests is registered in Program.cs');
ok(build.includes("'--defender-self-test'"),'the self-test runs in scripts/build-agent-v3.mjs');
ok(existsSync('agent/v3/NativeDefenderTests.cs'),'the self-test source exists');
// The collector shipped with 4.14.0; later releases keep it (4.15.0 adds the Defender actions).
const version=/internal const string BaseVersion = "(\d+)\.(\d+)\.(\d+)";/.exec(program),current=version?version.slice(1).join('.'):'';
ok(!!version&&(Number(version[1])>4||Number(version[1])===4&&Number(version[2])>=14),`Program.Version is 4.14.0 or later (${current})`);
ok(read('agent/v3/ServerDesk.Agent.csproj').includes(`<Version>${current}</Version>`),'the csproj has the same version');
ok(read('agent/v3/README.md').startsWith(`# ServerDesk native agent ${current}`)&&read('docs/native-agent-v4.md').startsWith(`# ServerDesk native agent ${current}`),'README and docs have the same version');
const changelog=JSON.parse(read('agent/v3/changelogs/4.14.0.json'));
ok(changelog.version==='4.14.0'&&changelog.features.some(line=>/Defender/.test(line)),'changelogs/4.14.0.json has the Defender feature line');

console.log(`PASS agent Defender source (${checks} checks): a fixed privileged broker read with its own deadline, only the five WMI classes, no write call, the capability defender-status, the registered self-test and release 4.14.0 or later.`);
