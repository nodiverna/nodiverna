// Static checks of the plugin report fix of agent 4.21.1 (agent/v3/PluginHost.cs,
// PluginSelfTests.cs): the version in Program.cs, the csproj and the README;
// the changelog 4.21.1 with its fix, also in lib/agent-changelog-history.json;
// Report() keeps the entry of a busy plugin from a per-plugin store that
// Invalidate() does not clear, and does not cache a report that skipped a busy
// plugin without one; InstallAsync and RemoveAsync release the gate before they
// invalidate; a removed plugin leaves the store; the new self-test is registered.
// Code without comments; no build (the self-test runs with --plugin-self-test).
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
// Code without comments, so that a comment that names a call does not count.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/(^|[^:"])\/\/.*$/,'$1')).join('\n');
/** The body of the member that starts with signature: from its first { to the matching }. */
const body=(source,signature)=>{
 const start=source.indexOf(signature);assert.ok(start>=0,`missing ${signature}`);
 let depth=0,index=source.indexOf('{',start);const from=index;
 for(;index<source.length;index++){if(source[index]==='{')depth++;else if(source[index]==='}'&&--depth===0)break;}
 return source.slice(from,index+1);
};
/** The text of the last finally block of a member body. */
const lastFinally=source=>{const at=source.lastIndexOf('finally');assert.ok(at>=0,'missing finally');return body(source.slice(at),'finally');};
const host=code('agent/v3/PluginHost.cs'),tests=code('agent/v3/PluginSelfTests.cs');

// ---- Version 4.21.1 and its changelog; a later agent keeps the fix ----
const version='4.21.1',fix='After a plugin install or removal, the status report no longer leaves out a plugin that runs a read at that moment, and a new plugin shows in the next heartbeat.';
const current=/internal const string BaseVersion = "(\d+\.\d+\.\d+)";/.exec(read('agent/v3/Program.cs'))?.[1]??'0.0.0';
const atLeast=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return true;};
ok(atLeast(current,version),'Program.Version is 4.21.1 or later');
ok(read('agent/v3/ServerDesk.Agent.csproj').includes(`<Version>${current}</Version>`),'the executable version is Program.Version');
const readme=read('agent/v3/README.md');
ok(readme.startsWith(`# ServerDesk native agent ${current}`)&&readme.includes(`the executable version are \`${current}\``),'the README names the agent version');
ok(existsSync('agent/v3/changelogs/4.21.1.json'),'the changelog 4.21.1 exists');
const changelog=JSON.parse(read('agent/v3/changelogs/4.21.1.json'));
ok(changelog.version===version&&changelog.fixes.includes(fix),'the changelog has the fix');
const history=JSON.parse(read('lib/agent-changelog-history.json'));
ok(history[0].version===current&&history.find(entry=>entry.version===version)?.fixes.includes(fix),'the changelog history starts with the agent version and keeps 4.21.1 with its fix');

// ---- Report(): the last entry of a busy plugin survives Invalidate() ----
ok(/private readonly Dictionary<string, JsonObject> lastEntries = new\(StringComparer\.Ordinal\);/.test(host),'a per-plugin last-entry store');
const invalidate=body(host,'internal void Invalidate()');
ok(/cached = null/.test(invalidate)&&!/lastEntries/.test(invalidate),'Invalidate() drops the cached report but not the last entries');
const report=body(host,'internal JsonArray Report()');
ok(/lock \(reportGate\)/.test(report),'Report() works under reportGate');
ok(!/cached\?\.Report/.test(report)&&!/previous/.test(report),'Report() no longer reads the kept entry only from the cached report');
ok(/if \(!gate\.Wait\(0\)\)\s*\{\s*if \(lastEntries\.TryGetValue\(name, out var kept\)\) report\.Add\(kept\.DeepClone\(\)\); else skipped = true;/.test(report),'a busy plugin keeps its last entry, else the report counts as skipped');
ok(/lastEntries\[name\] = \(JsonObject\)entry\.DeepClone\(\); report\.Add\(entry\);/.test(report),'every verified entry becomes the last entry of its plugin');
ok(/cached = skipped \? null : \(clock\(\), report\);/.test(report),'a report that skipped a busy plugin without an entry is not cached');
ok(/lastEntries\.Keys\.Where\(name => !names\.Contains\(name, StringComparer\.Ordinal\)\)/.test(report)&&/lastEntries\.Remove\(gone\)/.test(report),'a plugin whose folder is gone leaves the store');

// ---- InstallAsync and RemoveAsync: release the gate, then invalidate ----
for(const signature of ['internal async Task<JsonObject> InstallAsync(','internal async Task<JsonObject> RemoveAsync(']){
 const member=body(host,signature),last=lastFinally(member);
 const release=last.indexOf('gate.Release();'),drop=last.indexOf('Invalidate();');
 ok(release>=0&&drop>release,`${signature.match(/(\w+)\($/)[1]}: gate.Release() comes before Invalidate() in finally`);
 ok(!/Invalidate\(\);[^}]*gate\.Release\(\);/.test(last),`${signature.match(/(\w+)\($/)[1]}: no invalidation while the gate is still held in finally`);
}
const install=body(host,'internal async Task<JsonObject> InstallAsync(');
ok(!/Invalidate\(\); ScheduleAfterInstall/.test(install),'the install no longer invalidates while it holds the gate');
const remove=body(host,'internal async Task<JsonObject> RemoveAsync(');
ok(/Directory\.Delete\(PluginFiles\.Folder\(root, name\), true\);\s*lock \(reportGate\) lastEntries\.Remove\(name\);/.test(remove),'a removed plugin is not kept from the last-entry store');

// ---- The self-test ----
ok(/private static async Task KeptEntriesAsync\(/.test(tests),'the self-test of the kept entries exists');
ok(/await KeptEntriesAsync\(root, publisher, pem, host, factory, firewall, \(\) => now, next, script => current = script\);/.test(body(tests,'private static async Task RunAsync()')),'the plugin self-test runs it');
const kept=body(tests,'private static async Task KeptEntriesAsync(');
ok(/Place\(root, "dns"/.test(kept)&&/host\.RunAsync\("dhcp", "dhcp-read"/.test(kept),'two installed plugins, one held by a running read');
ok(/host\.Invalidate\(\);\s*Check\(Names\(host\.Report\(\)\) == "dhcp ready,dns ready", "A plugin with a busy gate left the report after Invalidate\(\)\."\);/.test(kept),'after Invalidate() the report still lists both');
ok(/hold\.SetResult\(\);[\s\S]*host\.Invalidate\(\);\s*Check\(Names\(host\.Report\(\)\) == "dhcp damaged,dns ready"/.test(kept),'after the release the next report is fresh');
ok(/A report that skipped a busy plugin was cached for its lifetime\./.test(kept)&&/A removed plugin stayed in the report\./.test(kept),'the uncached skip and the removal are checked');
ok(/args\[0\] == "--plugin-self-test"\) return await PluginSelfTests\.RunSelfTestAsync\(\)/.test(read('agent/v3/Program.cs')),'the plugin self-test stays registered in Program.cs');

// ---- Docs ----
const docs=read('docs/agent-plugins.md');
ok(/Installed · waiting for the agent/.test(docs)&&/keeps its last entry/.test(docs),'docs/agent-plugins.md describes the waiting state and the kept entries');

console.log(`PASS agent plugin report source (${checks} checks): version 4.21.1 with its changelog and history, the last-entry store that Invalidate() keeps, no cache for a report that skipped an unknown busy plugin, release before invalidate in install and removal, removed plugins not kept, the registered self-test and the docs.`);
