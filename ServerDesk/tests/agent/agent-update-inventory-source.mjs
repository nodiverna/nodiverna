// The update inventory fix of agent 4.21.3: Windows Update gives no severity
// (MsrcSeverity = null) for some updates. Agents up to 4.21.2 wrote that null
// into updates.json and then rejected the whole file, so every heartbeat had
// "The last update inventory could not be read." and the device showed
// "Inventory incomplete".
// Agent side (static C# checks, no build; the self-test runs with --self-test):
// NormalizeUpdates reads a missing or null string field as "" and still
// rejects a corrupt cache; SaveInventory writes "" for a null severity or
// title; both read paths use NormalizeUpdates; the new self-test case; the
// version 4.21.3 in all release files with its changelog and history.
// Portal side (no database): the schema accepts severity "", the
// inventory-incomplete rule is unchanged, and "" shows as "Not specified".
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
const {telemetry}=await import('../../lib/server/agent/telemetry.ts');
const {defaultAlertSettings,evaluateAlertRules}=await import('../../lib/alert-rules.ts');
const {updateSeverity}=await import('../../ui/devices/management/update-view.ts');
const {translate}=await import('../../lib/i18n/translate.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
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
const telemetrySource=code('agent/v3/NativeTelemetry.cs'),windowsUpdates=code('agent/v3/NativeWindowsUpdates.cs'),broker=code('agent/v3/AgentBroker.cs'),selfTests=code('agent/v3/NativeTelemetrySelfTests.cs');

// ---- NormalizeUpdates: null or missing string fields read as "", corrupt caches still throw ----
const normalize=body(telemetrySource,'internal static JsonObject NormalizeUpdates(JsonNode? node)');
const field=/string Field\(string field\) => [^\n]*/.exec(normalize)?.[0]??'';
ok(/item\[field\] switch \{ null => "",/.test(field),'Field() maps a missing key or a JSON null to ""');
ok(/JsonValue value when value\.TryGetValue<string>\(out string\? text\) => Limit\(text\)/.test(field),'Field() keeps a string value, limited');
ok(/_ => throw new InvalidDataException\("Invalid update field\."\)/.test(field),'Field() still throws for any other value, for example a number');
ok(/\["title"\] = Field\("title"\), \["kb"\] = Field\("kb"\), \["severity"\] = Field\("severity"\)/.test(normalize),'title, kb and severity go through Field()');
ok(/source\["checkedAt"\] is not JsonValue checkedAt \|\| !checkedAt\.TryGetValue<string>\(out var date\)/.test(normalize),'a missing or invalid checkedAt is still rejected');
ok(/pending < 0/.test(normalize)&&/source\["items"\] is not JsonArray items\) throw new InvalidDataException\("Invalid update inventory\."\)/.test(normalize),'a negative pendingCount or a missing items array is still rejected');
ok(/!Guid\.TryParse\(id, out var guid\)/.test(normalize)&&/!reboot\.TryGetValue<bool>\(out bool required\)\) throw new InvalidDataException\("Invalid update inventory entry\."\)/.test(normalize),'an item without a GUID id or a boolean rebootRequired is still rejected');
ok(/return new JsonObject \{ \["checkedAt"\] = Limit\(date\), \["pendingCount"\] = pending, \["items"\] = result \};/.test(normalize),'checkedAt and pendingCount stay unchanged');

// ---- Both read paths use NormalizeUpdates ----
ok(/snapshot\["updates"\] = NormalizeUpdates\(JsonNode\.Parse\(await File\.ReadAllTextAsync\(updates, token\)\)\)/.test(telemetrySource),'the direct read in CollectAsync normalizes updates.json');
ok(/NativeTelemetryCollector\.NormalizeUpdates\(JsonNode\.Parse\(File\.ReadAllText\(path\)\)\)/.test(body(broker,'private JsonObject Updates()')),'the broker Updates() normalizes updates.json');

// ---- SaveInventory writes "" instead of null ----
const save=body(windowsUpdates,'private static void SaveInventory(string root, Search search)');
ok(!/\["severity"\] = \(string\)update\.MsrcSeverity\s*,/.test(save)&&!/\["title"\] = \(string\)update\.Title\s*,/.test(save),'no bare cast of MsrcSeverity or Title into the JSON field');
ok(/\["severity"\] = \(string\?\)update\.MsrcSeverity \?\? ""/.test(save),'severity falls back to ""');
ok(/\["title"\] = \(string\?\)update\.Title \?\? ""/.test(save),'title falls back to ""');

// ---- The self-test case ----
const run=body(selfTests,'internal static async Task RunAsync()');
const unrated=/var unrated = NativeTelemetryCollector\.NormalizeUpdates\(([\s\S]*?)\) \}\);/.exec(run)?.[1]??'';
ok(/\["severity"\] = null/.test(unrated),'the self-test normalizes an item with severity = null');
ok(/\["title"\] = "Feature update", \["kb"\] = "KB1", \["rebootRequired"\] = true \}/.test(unrated),'the self-test normalizes an item without a severity key');
ok(/\["kb"\] = null/.test(unrated),'the self-test normalizes an item with kb = null');
ok(/unrated\["pendingCount"\]!\.GetValue<int>\(\) != 3/.test(run)&&/unratedItems\[0\]!\["severity"\]!\.GetValue<string>\(\) != ""/.test(run)&&/unratedItems\[1\]!\["severity"\]!\.GetValue<string>\(\) != ""/.test(run)&&/unratedItems\[2\]!\["kb"\]!\.GetValue<string>\(\) != ""/.test(run),'the self-test checks "" for all three and the kept pendingCount');
ok(/\["severity"\] = 5/.test(run)&&/if \(!numericFieldRejected\) throw/.test(run),'the self-test checks that a numeric field is still rejected');
ok(/NormalizeUpdates\(new JsonObject \{ \["pendingCount"\] = -1 \}\)/.test(run)&&/if \(!corruptUpdateRejected\) throw/.test(run),'the corrupt cache self-test stays');

// ---- Version 4.21.3 and its changelog; a later agent keeps the fix ----
const version='4.21.3',fix="Devices no longer show 'Inventory incomplete' when Windows Update lists an update without a severity. The update list is read again, and such updates show with the priority 'Not specified'.";
const current=/internal const string BaseVersion = "(\d+\.\d+\.\d+)";/.exec(read('agent/v3/Program.cs'))?.[1]??'0.0.0';
const atLeast=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return true;};
ok(atLeast(current,version),'Program.Version is 4.21.3 or later');
ok(read('agent/v3/ServerDesk.Agent.csproj').includes(`<Version>${current}</Version>`),'the csproj version is Program.Version');
const firstLine=file=>read(file).split(/\r?\n/)[0];
check(firstLine('agent/v3/README.md'),`# ServerDesk native agent ${current}`,'the README names the agent version');
check(firstLine('docs/native-agent-v4.md'),`# ServerDesk native agent ${current}`,'docs/native-agent-v4.md names the agent version');
ok(existsSync(`agent/v3/changelogs/${version}.json`),'the changelog 4.21.3 exists');
const changelog=JSON.parse(read(`agent/v3/changelogs/${version}.json`));
ok(changelog.version===version&&changelog.fixes.includes(fix)&&/Inventory incomplete/.test(fix),'the changelog has the fix that names the Inventory incomplete signal');
const history=JSON.parse(read('lib/agent-changelog-history.json'));
ok(history[0].version===current&&history.find(entry=>entry.version===version)?.fixes.includes(fix),'the changelog history starts with the agent version and keeps 4.21.3 with its fix');
ok(/## Fixes in 4\.21\.3/.test(read('docs/native-agent-v4.md')),'docs/native-agent-v4.md describes the fix');

// ---- Portal: schema, rule and view ----
const now=Date.parse('2026-11-14T12:00:00.000Z');
const snapshot={hostname:'NFI-WS01',os:'Windows 11 Pro',build:'26100',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.21.3',mode:'ReadOnly',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:[],
 updates:{checkedAt:new Date(now).toISOString(),pendingCount:1,items:[{id:'0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',title:'Security Intelligence Update for Microsoft Defender Antivirus',kb:'KB2267602',severity:'',rebootRequired:false}]}};
const parsed=telemetry.safeParse(snapshot);
ok(parsed.success,'the portal schema accepts an update with severity ""');
check(parsed.data.updates.items[0].severity,'','the empty severity is kept');
const incomplete=collectionErrors=>evaluateAlertRules({lastSeen:now,snapshot:{...parsed.data,collectionErrors}},defaultAlertSettings(),now).filter(issue=>issue.ruleId==='inventory-incomplete');
check(incomplete([]).length,0,'no inventory-incomplete issue with an update without severity and no collection error');
check(incomplete(['The last update inventory could not be read.']).length,1,'the rule still fires for the update inventory read error');
check(incomplete(['Drivers could not be read (BrokerException).']).length,1,'the rule still fires for a real collection error');
check(updateSeverity('','en'),translate('en','management.updates.notSpecified'),'"" shows as Not specified');
check(updateSeverity('','de'),translate('de','management.updates.notSpecified'),'"" shows as Nicht angegeben');

console.log(`PASS agent update inventory source (${checks} checks): NormalizeUpdates reads null or missing strings as "" and still rejects corrupt caches, SaveInventory writes "", both read paths, the self-test case, version 4.21.3 with changelog and history, and the portal schema, rule and priority text.`);
