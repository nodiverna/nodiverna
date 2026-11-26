// Static checks of the DHCP plugin memory fix of plugin 1.1.1
// (agent/plugins/dhcp/DhcpApi.cs and DhcpChanges.cs): no DhcpRpcFreeMemory and
// no free helper on memory that dhcpsapi.dll returned (freeing nested pointers
// corrupted the heap, 0xC0000374, on a server with scopes); the Native scope of
// the writer still owns, clears and frees the input structs; the memory rule
// comment in both files; the rollback of CreateScope; version 1.1.1 with its
// changelog and the capabilities of 1.1.0. Code without comments; no build (the
// layout and change checks run with --self-test in the plugin build).
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
const dir='agent/plugins/dhcp';
const files={api:`${dir}/DhcpApi.cs`,changes:`${dir}/DhcpChanges.cs`};
const api=code(files.api),changes=code(files.changes);

// ---- No free of API memory ----
// A free helper call that is not a member call (NativeLibrary.Free of a library handle stays) and not FreeHGlobal.
const freeCall=/(?<![\w.])(Free|FreeHost|FreeData|FreePolicy|FreeRelationship)\s*\(/g;
for(const [name,source] of [['DhcpApi.cs',api],['DhcpChanges.cs',changes]]){
 ok(!/DhcpRpcFreeMemory/.test(source),`${name}: no DhcpRpcFreeMemory import or call`);
 ok(!/extern\s+void\s+\w*Free\w*\s*\(/.test(source),`${name}: no extern free function`);
 const calls=[...source.matchAll(freeCall)].map(match=>match[0]);
 ok(calls.length===0,`${name}: no Free, FreeHost, FreeData, FreePolicy or FreeRelationship call or helper (found ${calls.join(', ')})`);
 const members=[...source.matchAll(/\.(Free\w*)\s*\(/g)].map(match=>match[1]);
 ok(members.every(member=>member==='FreeHGlobal'||member==='Free'),`${name}: no other member free call (found ${members.join(', ')})`);
 ok([...source.matchAll(/(\w+)\.Free\s*\(/g)].every(match=>match[1]==='NativeLibrary'),`${name}: the only .Free( is NativeLibrary.Free of the library handle`);
 ok(!/\bfinally\b/.test(source),`${name}: no finally block is left (they only freed API memory)`);
}
ok(!/DhcpApi\.Free\w*\(/.test(changes),'DhcpChanges.cs: no free helper of DhcpApi is used');

// ---- The Native scope owns the input structs ----
ok(/private sealed class Native : IDisposable/.test(changes),'the Native scope exists');
const native=body(changes,'private sealed class Native : IDisposable');
ok(/Marshal\.AllocHGlobal\(bytes\)/.test(native)&&/Marshal\.StringToHGlobalUni\(value\)/.test(native),'Native allocates the input structs and strings with Marshal');
ok(/new Span<byte>\(\(void\*\)block, bytes\)\.Clear\(\); Marshal\.FreeHGlobal\(block\);/.test(native),'Native zeroes each block before Marshal.FreeHGlobal on dispose');
ok(/Marshal\.AllocHGlobal/.test(changes)&&/\.Clear\(\)/.test(changes)&&/Marshal\.FreeHGlobal/.test(changes),'AllocHGlobal, Clear and FreeHGlobal stay in DhcpChanges.cs');

// ---- The memory rule in both files ----
for(const [name,file] of Object.entries(files)){
 const raw=read(file),flat=raw.replace(/\s*(\/\/\/?|\r?\n)\s*/g,' ');
 ok(raw.includes('0xC0000374'),`${name}: the memory rule names the heap corruption 0xC0000374`);
 ok(/one request/.test(flat)||raw.includes('agent/v3/PluginHost.cs'),`${name}: the memory rule names the one request of the broker or PluginHost.cs`);
 ok(/not freed|never freed/.test(flat),`${name}: the memory rule says that API memory is not freed`);
 ok(!/freed with DhcpRpcFreeMemory/.test(flat),`${name}: the old sentence about DhcpRpcFreeMemory is gone`);
}

// ---- The rollback of CreateScope ----
const create=body(changes,'public void CreateScope(');
ok(/Ok\("DhcpCreateSubnet", DhcpCreateSubnet\(null, subnet, ref info\), Ip\(subnet\)\);/.test(create),'CreateScope creates the subnet');
ok(/try \{ Range\(subnet, start, end, type, add: true\); Lease\(subnet, leaseSeconds\); if \(activate\) SetSubnet\(subnet, null, null, 0\); \}\s*catch \{ DhcpDeleteSubnet\(null, subnet, FullForce\); throw; \}/.test(create),'a failed range, lease or state step deletes the new subnet again');
ok(/Ok\("DhcpGetSubnetInfo", DhcpGetSubnetInfo\(null, scope, out var info\), Ip\(scope\)\);\s*return use\(\*info\);/.test(body(changes,'private static T WithSubnet<T>(')),'WithSubnet reads the subnet and hands a copy of the struct to the change');

// ---- Version 1.1.1, its changelog and the capabilities of 1.1.0 ----
const program=read(`${dir}/Program.cs`),project=read(`${dir}/ServerDesk.Plugin.Dhcp.csproj`);
const version=/internal const string Name = "dhcp", BaseVersion = "(\d+\.\d+\.\d+)", Version = BaseVersion \+ BuildVersion\.DevSuffix;/.exec(program)?.[1];
ok(version==='1.1.1','Program.Version is 1.1.1');
ok(/<Version>([^<]+)<\/Version>/.exec(project)?.[1]===version,'the csproj version is Program.Version');
ok(existsSync(`${dir}/changelogs/1.1.1.json`),'the changelog 1.1.1 exists');
const changelog=JSON.parse(read(`${dir}/changelogs/1.1.1.json`));
ok(changelog.version==='1.1.1'&&Array.isArray(changelog.features)&&changelog.features.length===0,'the changelog has version 1.1.1 and no features');
ok(Array.isArray(changelog.fixes)&&changelog.fixes.length===1&&/Reading and changing a DHCP server that has scopes/.test(changelog.fixes[0])&&/-1073740940/.test(changelog.fixes[0]),'the changelog has one fix for reading and changing a server with scopes');
const capabilities110=['dhcp-read','dhcp-scope-create','dhcp-scope-edit','dhcp-scope-activate','dhcp-scope-deactivate','dhcp-scope-delete','dhcp-superscope-create','dhcp-superscope-edit','dhcp-superscope-activate','dhcp-superscope-deactivate','dhcp-superscope-delete','dhcp-exclusion-add','dhcp-exclusion-remove','dhcp-reservation-add','dhcp-reservation-edit','dhcp-reservation-remove','dhcp-lease-delete','dhcp-option-set','dhcp-option-remove','dhcp-policy-create','dhcp-policy-edit','dhcp-policy-delete','dhcp-failover-create','dhcp-failover-edit','dhcp-failover-remove','dhcp-scope-apply'];
const projectCapabilities=/<PluginCapabilities>([^<]+)<\/PluginCapabilities>/.exec(project)?.[1].split(';');
assert.deepEqual(projectCapabilities,capabilities110,'the csproj capabilities are those of 1.1.0');checks++;
const operations=[...(/Operations =\s*\[([^\]]+)\]/.exec(changes)?.[1]??'').matchAll(/"([a-z0-9-]+)"/g)].map(match=>match[1]);
ok(/Capabilities = \["dhcp-read", \.\. DhcpChanges\.Operations\]/.test(program),'Program.Capabilities is dhcp-read and the operations');
assert.deepEqual(['dhcp-read',...operations],capabilities110,'Program.Capabilities are those of 1.1.0: 26 entries, dhcp-read first');checks++;
ok(/<PluginMinAgentVersion>4\.16\.0<\/PluginMinAgentVersion>/.test(project),'the minimum agent version stays 4.16.0');

console.log(`PASS DHCP plugin memory source (${checks} checks): no DhcpRpcFreeMemory and no free helper in DhcpApi.cs and DhcpChanges.cs, the Native scope still owns and zeroes the input structs, the memory rule in both files, the CreateScope rollback, version 1.1.1 with its changelog and the 26 capabilities of 1.1.0.`);
