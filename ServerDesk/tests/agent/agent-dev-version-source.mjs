// Dev builds in the agent and plugin sources (X.Y.Z-dev.<sha7>): the version rule of ReleaseVersion.cs, the dev-aware
// VerifyManifest and PrepareAsync (CheckTarget) of AgentUpdater.cs, the plugin version patterns of PluginProtocol.cs,
// the minimum check of PluginManifests.Verify by the base, the self-tests that cover them and that the build runs,
// and the version chain: the csproj <Version> is the one base, Program.cs adds BuildVersion.DevSuffix that
// agent/BuildVersion.targets writes from the suffix the build scripts pass to dotnet publish.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serverDeskRoot } from '../support/paths.mjs';

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const read = file => readFileSync(path.join(serverDeskRoot, file), 'utf8');

// ---- ReleaseVersion.cs: the rule of runtime/release-version.mjs ----
const version = read('agent/v3/ReleaseVersion.cs');
ok(version.includes(String.raw`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-dev\.[0-9a-f]{7})?\z`), 'X.Y.Z without leading zeros, an optional lowercase -dev.<sha7>, [0-9] (not Unicode \\d)');
ok(/internal static int CompareRank\(string left, string right\)[\s\S]*?return devLeft == devRight \? 0 : devLeft \? -1 : 1;/.test(version), 'the rank: the base first, a release above a dev build, two dev builds equal');

// ---- AgentUpdater.cs ----
const updater = read('agent/v3/AgentUpdater.cs');
ok(/if \(!ReleaseVersion\.IsValid\(version\) \|\| version\.Length > 40\) throw new InvalidDataException\("Invalid release version"\);/.test(updater), 'VerifyManifest accepts X.Y.Z and dev builds only');
ok(/if \(ReleaseVersion\.Base\(version\)\.Major >= 4 && \(data\["layout"\]/.test(updater), 'the single-EXE rule uses the base');
ok(!/System\.Version\.(?:Try)?Parse/.test(updater), 'no System.Version parse of a release version is left');
ok(/CheckTarget\(version, Program\.Version\);/.test(updater), 'PrepareAsync checks the target through CheckTarget');
ok(/if \(ReleaseVersion\.CompareRank\(target, installed\) < 0\) throw new InvalidOperationException\("Agent downgrades are not supported\."\);\s*if \(target == installed\) throw new InvalidOperationException\("This release is already installed\."\);/.test(updater), 'a lower rank is a downgrade, the identical string is installed');

// ---- PluginProtocol.cs and PluginHost.cs ----
const protocol = read('agent/plugins/shared/PluginProtocol.cs');
ok(protocol.includes(String.raw`VersionPattern = new(@"^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-dev\.[0-9a-f]{7})?\z"`), 'a plugin version may carry the dev suffix');
ok(protocol.includes(String.raw`BaseVersionPattern = new(@"^\d{1,5}\.\d{1,5}\.\d{1,5}\z"`) && /internal static bool IsBaseVersion\(string\? value\)/.test(protocol), 'the minimum agent version stays X.Y.Z');
const host = read('agent/v3/PluginHost.cs');
ok(/!PluginProtocol\.IsVersion\(version\) \|\| !PluginProtocol\.IsBaseVersion\(minimum\)/.test(host), 'the manifest: a dev plugin version, a plain minimum');
ok(/!System\.Version\.TryParse\(minimum, out var needed\) \|\| !ReleaseVersion\.TryParse\(agentVersion, out var running, out _\) \|\| needed > running/.test(host), 'the minimum is compared with the base of the running agent');

// ---- The self-tests that the build runs ----
const installerTests = read('agent/v3/NativeInstallerTests.cs');
ok(/4\.21\.5-dev\.abc1234/.test(installerTests) && /"4\.21\.5-dev\.ABC1234", "4\.21\.5-dev\.abc123", "4\.21\.5-rc\.1", "4\.21\.5-dev\.abc1234\.1", "04\.1\.0"/.test(installerTests), 'the installer self-test: a dev manifest verifies, malformed suffixes are refused');
ok(/private static void VerifyUpdateRanks\(\)/.test(installerTests) && /VerifyUpdateRanks\(\);/.test(installerTests), 'the installer self-test runs the downgrade cases');
for (const [target, installed] of [['4.21.5-dev.abc1234', '4.21.5'], ['4.21.5-dev.abc1234', '4.21.5-dev.abc1234'], ['4.21.5-dev.bbbbbbb', '4.21.5-dev.aaaaaaa'], ['4.21.5-dev.abc1234', '4.21.4'], ['4.21.5', '4.21.5-dev.abc1234']]) {
  ok(installerTests.includes(`("${target}", "${installed}"`), `the update case ${installed} → ${target}`);
}
const pluginTests = read('agent/v3/PluginSelfTests.cs');
ok(/Sign\(publisher, "dhcp", "1\.0\.1-dev\.abc1234", exe\)/.test(pluginTests), 'the plugin self-test: a dev plugin manifest');
ok(/"dhcp", "4\.21\.5-dev\.abc1234", pem\)\) == "none"/.test(pluginTests), 'the plugin self-test: a dev agent meets the minimum of its base');
ok(/minAgent: "4\.16\.0-dev\.abc1234"/.test(pluginTests), 'the plugin self-test: a dev minimum is refused');
const build = read('scripts/build-agent-v3.mjs');
ok(build.includes("'--installer-self-test'") && build.includes("'--plugin-self-test'"), 'build-agent-v3.mjs runs both self-tests on the packaged EXE');

// ---- The version chain: csproj → Program.cs + BuildVersion.DevSuffix → --version ----
const targets = read('agent/BuildVersion.targets');
ok(targets.includes(String.raw`'^-dev\.[0-9a-f]{7}$'`) && targets.includes('internal const string DevSuffix = &quot;$(ServerDeskDevSuffix)&quot;'), 'the targets file checks the suffix and writes BuildVersion.DevSuffix');
const agentProject = read('agent/v3/ServerDesk.Agent.csproj'), agentProgram = read('agent/v3/Program.cs');
const agentBase = /<Version>([^<]+)<\/Version>/.exec(agentProject)?.[1];
check(/internal const string BaseVersion = "([^"]+)";/.exec(agentProgram)?.[1], agentBase, 'Program.BaseVersion is the csproj <Version>');
ok(/internal const string Version = BaseVersion \+ BuildVersion\.DevSuffix;/.test(agentProgram), 'Program.Version adds the dev suffix');
ok(agentProject.includes('<Import Project="../BuildVersion.targets" />'), 'the agent project imports the targets');
for (const [name, pascal] of [['dhcp', 'Dhcp'], ['dns', 'Dns']]) {
  const project = read(`agent/plugins/${name}/ServerDesk.Plugin.${pascal}.csproj`), program = read(`agent/plugins/${name}/Program.cs`);
  const base = /<Version>([^<]+)<\/Version>/.exec(project)?.[1];
  check(new RegExp(`internal const string Name = "${name}", BaseVersion = "([^"]+)", Version = BaseVersion \\+ BuildVersion\\.DevSuffix;`).exec(program)?.[1], base, `${name}: BaseVersion is the csproj <Version>, Version adds the suffix`);
  ok(project.includes('<Import Project="../../BuildVersion.targets" />'), `${name}: the project imports the targets`);
  ok(/PluginHello\(Name, Version, Capabilities\)/.test(program) && /Console\.WriteLine\(Version\)/.test(program), `${name}: the hello and --version carry the full version`);
}
ok(/buildVersion\(projectVersion,process\.env\.SERVERDESK_AGENT_VERSION\)/.test(build) && build.includes('`-p:ServerDeskDevSuffix=${devSuffix}`'), 'the agent build passes the suffix of SERVERDESK_AGENT_VERSION to dotnet publish');
ok(/actual\.stdout\.trim\(\)!==version/.test(build), 'the --version check compares with the full version');
const pluginBuild = read('scripts/build-plugin.mjs');
ok(/buildVersion\(metadata\.version, env\.SERVERDESK_PLUGIN_VERSION\)/.test(pluginBuild) && pluginBuild.includes('`-p:ServerDeskDevSuffix=${devSuffix}`'), 'the plugin build passes the suffix of SERVERDESK_PLUGIN_VERSION');
ok(/version\.stdout\.trim\(\) !== metadata\.version/.test(pluginBuild), 'the plugin --version check compares with the full version');

console.log(`PASS agent dev version source (${checks} checks): ReleaseVersion, VerifyManifest and CheckTarget by rank, the plugin version patterns and the minimum by base, the self-tests the build runs, and csproj → Program.cs → BuildVersion.DevSuffix for the agent, dhcp and dns.`);
