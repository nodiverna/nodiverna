// Static checks of the Microsoft Defender actions of agent 4.15.0
// (agent/v3/NativeDefenderControl.cs): only the three static methods
// MSFT_MpScan.Start, MSFT_MpSignature.Update and MSFT_MpThreat.Remove plus reads
// of MSFT_MpComputerStatus and MSFT_MpThreat; no PowerShell, MpCmdRun, process
// start, preference, exclusion, allow or restore call. The 4 kinds are
// JobRunner.DefenderActions and capabilities, not read actions; the scan slot
// reaches the Heartbeat through the broker status; the self-test is registered;
// the release is 4.15.0 or later. No build.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
// Code without comments, so that a comment that names a forbidden call does not count.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/\/\/.*$/,'')).join('\n');
const source=code('agent/v3/NativeDefenderControl.cs'),runner=code('agent/v3/JobRunner.cs'),worker=code('agent/v3/AgentWorker.cs'),broker=code('agent/v3/AgentBroker.cs'),program=read('agent/v3/Program.cs'),build=read('scripts/build-agent-v3.mjs');
const kinds=['defender-quick-scan','defender-full-scan','defender-update-signatures','defender-clean-detections'];

// ---- Only the three methods and two read classes ----
const invokes=[...source.matchAll(/WindowsManagement\.Invoke\(DefenderNamespace, "(\w+)", "(\w+)"/g)].map(match=>match[1]+'.'+match[2]);
ok(JSON.stringify(invokes.sort())===JSON.stringify(['MSFT_MpScan.Start','MSFT_MpSignature.Update','MSFT_MpThreat.Remove']),`exactly the three static methods (${invokes.join(', ')})`);
ok((source.match(/WindowsManagement\.Invoke\(/g)??[]).length===3,'no other method call');
const reads=[...source.matchAll(/FROM (\w+)/g)].map(match=>match[1]);
ok(reads.length>=3&&reads.every(name=>['MSFT_MpComputerStatus','MSFT_MpThreat'].includes(name)),`reads only MSFT_MpComputerStatus and MSFT_MpThreat (${[...new Set(reads)].join(', ')})`);
ok(/private const string DefenderNamespace = @"root\\Microsoft\\Windows\\Defender";/.test(source),'the Defender namespace');
ok(/\["ScanType"\] = scanType/.test(source)&&/\(byte\)1 : \(byte\)2/.test(source),'ScanType 1 (quick) and 2 (full)');
ok(/"MSFT_MpSignature", "Update", null,/.test(source)&&/"MSFT_MpThreat", "Remove", null,/.test(source),'Update without an update source, Remove without parameters');
for(const forbidden of ['ExecMethod','InvokeMethod','PowerShell','MpCmdRun','Process.Start','ProcessStartInfo','MSFT_MpPreference','ThreatIDDefaultAction','Exclusion','Set-Mp','Add-Mp','Remove-Mp','Start-MpScan','Update-MpSignature','Restore','Allow','CreateInstance','Put(','Delete(','SetPropertyValue'])
 ok(!source.includes(forbidden),`the actions never use ${forbidden}`);
ok(!/\bRegistry\.\w+/.test(source),'no registry access');
ok(!code('agent/v3/NativeDefender.cs').includes('Invoke('),'the collector stays without a method call');

// ---- Job runner, capabilities, refresh ----
const list=/internal static readonly string\[\] DefenderActions = \[([^\]]*)\];/.exec(runner);
ok(!!list&&JSON.stringify(JSON.parse('['+list[1]+']'))===JSON.stringify(kinds),'JobRunner.DefenderActions holds the 4 kinds');
const readActions=/internal static readonly string\[\] ReadActions = \[([^\]]*)\];/.exec(runner)[1];
ok(kinds.every(kind=>!readActions.includes(`"${kind}"`)),'no Defender kind is a read action, so ReadOnly mode refuses it with AGENT_READONLY');
ok(/else if \(DefenderActions\.Contains\(action\)\) result = await new NativeDefenderControl\(DefenderScans, defenderProvider\)\.ExecuteAsync\(job, token\);/.test(runner),'the dispatch');
ok(/if \(DefenderActions\.Contains\(action\) \|\|/.test(runner),'every Defender job refreshes the inventory, also a failed one');
ok(/DefenderScans = new DefenderScanSlot\(refreshInventory\)/.test(runner),'the end of a portal scan refreshes the inventory');
ok(/\.Concat\(JobRunner\.DefenderActions\)/.test(worker),'the 4 kinds are capabilities');
ok(/\["defenderScan"\] = jobs\.DefenderScans\.State\(\)/.test(broker),'the broker status carries the scan slot');
ok(/if \(status\["defenderScan"\] is JsonObject defenderScan\) latest\["defenderScan"\] = defenderScan\.DeepClone\(\); else latest\.Remove\("defenderScan"\);/.test(worker),'the Heartbeat has defenderScan only while the slot is busy');
ok(/TimeSpan\.FromHours\(24\)/.test(source)&&/TimeSpan\.FromSeconds\(60\)/.test(source)&&/SignatureMinutes = 15, CleanMinutes = 10/.test(source),'60 s scan wait, 15 and 10 minutes, release after 24 h');

// ---- Self-test, release ----
ok(program.includes('args[0] == "--defender-control-self-test") return await NativeDefenderControlTests.RunSelfTestAsync();'),'NativeDefenderControlTests is registered in Program.cs');
ok(build.includes("'--defender-control-self-test'"),'the self-test runs in scripts/build-agent-v3.mjs');
ok(existsSync('agent/v3/NativeDefenderControlTests.cs'),'the self-test source exists');
const version=/internal const string BaseVersion = "(\d+)\.(\d+)\.(\d+)";/.exec(program);
ok(!!version&&(Number(version[1])>4||Number(version[1])===4&&Number(version[2])>=15),'Program.Version is 4.15.0 or later');
ok(existsSync('agent/v3/changelogs/4.15.0.json')&&JSON.parse(read('agent/v3/changelogs/4.15.0.json')).features.some(line=>/Defender/.test(line)),'changelogs/4.15.0.json has the Defender feature line');
ok(read('docs/native-agent-v4.md').includes('## Microsoft Defender actions in 4.15.0'),'the docs section');

console.log(`PASS agent Defender control source (${checks} checks): only MSFT_MpScan.Start, MSFT_MpSignature.Update and MSFT_MpThreat.Remove with status reads, no forbidden call, the 4 kinds as Defender actions and capabilities outside the read actions, the scan slot in the Heartbeat, the registered self-test and release 4.15.0.`);
