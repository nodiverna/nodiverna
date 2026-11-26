// Static checks of the zone create of DNS plugin 1.0.4 (agent/plugins/dns,
// docs/dns-server.md), which keep every guarantee of 1.0.3: the WMI error
// object of a failed ExecMethod, PutInstance or DeleteInstance (GetErrorInfo,
// IWbemClassObject, StatusCode, else MSFT_WmiError.error_Code) gives the
// provider code that Code prefers, and now also Description, ProviderName and
// Operation (else MSFT_WmiError.Message); a failed GetMethod or Put of a method
// input names its class and step and carries the method or parameter names;
// a zone create calls the modern provider root\Microsoft\Windows\DNS
// (PS_DnsServer*Zone, the classes of Add-DnsServer*Zone) first through one
// order function, with MicrosoftDNS_Zone.CreateZone as the fallback, never for
// a conditional forwarder; a failed create reads the zones again; the zone list
// adds the zones that only DnsServerZone reports and a delete reaches them
// through the modern provider; a failed change carries its result args and
// PLUGIN_DNS_CHANGE_FAILED_DETAIL; version 1.0.4 with its changelog, the
// minimum agent and the capabilities unchanged; the self-test cases (a)-(n);
// the documentation. Code without comments; no build (the self-test runs in
// the plugin build on Windows).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {serverDeskRoot} from '../support/paths.mjs';
import {validateReleaseChangelog} from '../../scripts/release-changelog.mjs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(path.join(serverDeskRoot,file),'utf8');
// Code without comments, so that a comment that names a call does not count.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/(^|[^:"])\/\/.*$/,'$1')).join('\n');
/** The body of the member that starts with signature: from its first { to the matching }. */
const body=(source,signature)=>{
 const start=source.indexOf(signature);assert.ok(start>=0,`missing ${signature}`);
 let depth=0,index=source.indexOf('{',start);const from=index;
 for(;index<source.length;index++){if(source[index]==='{')depth++;else if(source[index]==='}'&&--depth===0)break;}
 return source.slice(from,index+1);
};
const dir='agent/plugins/dns';
const api=code(`${dir}/DnsApi.cs`),changes=code(`${dir}/DnsChanges.cs`),snapshot=code(`${dir}/DnsSnapshot.cs`),program=code(`${dir}/Program.cs`),selfTests=read(`${dir}/DnsSelfTests.cs`);

// ---- The WMI error object ----
ok(/\[DllImport\("oleaut32\.dll"\)\][^\n]*\bGetErrorInfo\s*\(/.test(api),'DnsApi.cs imports oleaut32!GetErrorInfo');
ok(api.includes('"dc12a681-737f-11cf-884d-00aa004b2e24"'),'DnsApi.cs holds the IID of IWbemClassObject');
const details=body(api,'internal static WmiErrorDetails ErrorDetails(int hresult)');
ok(/GetErrorInfo\(0,/.test(details)&&/Slot\(info, 0\)/.test(details),'ErrorDetails reads the error object and queries it with IUnknown::QueryInterface (slot 0)');
ok(details.indexOf('"StatusCode"')>=0&&details.indexOf('"StatusCode"')<details.indexOf('"error_Code"'),'the provider code is StatusCode, else error_Code of MSFT_WmiError');
ok(/\(value & 0xFFFFFFFFL\) != unchecked\(\(uint\)hresult\)/.test(details)&&/value != 0/.test(details),'a provider code that only repeats the HRESULT, or 0, stays null');
ok(details.indexOf('"Description"')>=0&&details.indexOf('"Description"')<details.indexOf('"Message"')&&details.includes('"ProviderName"')&&details.includes('"Operation"'),'the description is Description of __ExtendedStatus, else Message of MSFT_WmiError, with ProviderName and Operation');
ok(/finally\s*\{\s*Release\(error\);\s*Release\(info\);\s*\}/.test(details)&&/using \(status\)/.test(details),'ErrorDetails releases both COM objects in every path');
ok(/catch \(Exception\)\s*\{\s*return WmiErrorDetails\.None;\s*\}/.test(details)&&(details.match(/Safe\(\(\) =>/g)??[]).length>=4,'a failure while reading gives nulls, each value on its own, never another exception');
ok(/private static T\? Safe<T>\(Func<T\?> read\) \{ try \{ return read\(\); \} catch \(Exception\) \{ return default; \} \}/.test(api),'Safe turns a failed read into null');
const checkWmi=body(api,'internal static void CheckWmi(int hresult, string call)');
ok(/ErrorDetails\(hresult\)/.test(checkWmi)&&/new WmiException\(call, hresult, details\.ProviderCode, details\.Description, details\.ProviderName, details\.Operation\)/.test(checkWmi),'CheckWmi carries the error object details into WmiException');
ok(/Com\.CheckWmi\([^\n]*Slot\(services, 14\)[^\n]*"PutInstance"\)/.test(api),'PutInstance (slot 14) reads the error object');
ok(/Com\.CheckWmi\([^\n]*Slot\(services, 16\)[^\n]*"DeleteInstance"\)/.test(api),'DeleteInstance (slot 16) reads the error object');
ok(/Com\.CheckWmi\([^\n]*Slot\(services, 24\)[^\n]*, call\)/.test(api)&&/string call = className \+ " ExecMethod " \+ method;/.test(api),'ExecMethod (slot 24) reads the error object and names the class');
ok(/class WmiException\(string call, int hresult, long\? providerCode = null, string\? description = null, string\? providerName = null, string\? operation = null, string\? signature = null\)/.test(api),'WmiException carries the nullable provider code, description, provider name, operation and signature');
ok(/internal long\? ProviderCode \{ get; \} = providerCode;/.test(api)&&/internal string\? Description \{ get; \} = description;/.test(api)&&/internal string\? ProviderName \{ get; \} = providerName;/.test(api)&&/internal string\? Operation \{ get; \} = operation;/.test(api),'the details are properties of WmiException');
ok(/internal long Code => Unwrap\(ProviderCode \?\? unchecked\(\(uint\)HResult32\)\);/.test(api),'Code prefers the provider code and unwraps FACILITY_WIN32');
ok(/AccessDenied =>[^\n]*ProviderCode is long code && Unwrap\(code\) == 5/.test(api),'AccessDenied is also true for provider code 5');
ok(/hresult\.ToString\("X8"[^\n]*", provider code "[^\n]*", no provider code\."/.test(api),'the message names the HRESULT and the provider code');

// ---- Lookup steps without an error object ----
const methodInput=body(api,'internal WmiObject MethodInput(string className, string method)');
ok(/Slot\(Pointer, 19\)/.test(methodInput)&&/className \+ " GetMethod " \+ method/.test(methodInput)&&/MethodNames\(\)/.test(methodInput)&&/SchemaStep = true/.test(methodInput),'a failed GetMethod names the class and the step and carries the method names');
const methodNames=body(api,'internal string? MethodNames()');
ok(/Slot\(Pointer, 22\)/.test(methodNames)&&/Slot\(Pointer, 23\)/.test(methodNames)&&/Slot\(Pointer, 24\)/.test(methodNames)&&/finally/.test(methodNames)&&/catch \(Exception\) \{ return null; \}/.test(methodNames),'the method names come from BeginMethodEnumeration (22), NextMethod (23) and EndMethodEnumeration (24), and a failure gives null');
ok(/SysFreeString\(name\)/.test(methodNames),'every method name BSTR is freed');
const propertyNames=body(api,'internal string? PropertyNames()');
ok(/Slot\(Pointer, 7\)/.test(propertyNames)&&/0x40/.test(propertyNames)&&/SafeArrayDestroy\(array\)/.test(propertyNames)&&/catch \(Exception\) \{ return null; \}/.test(propertyNames),'the parameter names come from GetNames (slot 7, non-system only), the array is destroyed and a failure gives null');
const call=body(api,'internal void Call(string path, string className, string method, IReadOnlyDictionary<string, object?>? values = null, bool checkReturn = false)');
ok(/className \+ " Put " \+ pair\.Key/.test(call)&&/input\.PropertyNames\(\)/.test(call)&&/className \+ " GetObject"/.test(call),'a failed Put of a method input and a failed GetObject of the class name the class and the step; the Put carries the parameter names');
ok(/"ReturnValue"/.test(call)&&/checkReturn/.test(call),'a nonzero ReturnValue of a modern method fails');
ok(/NotFound => HResult32 == unchecked\(\(int\)0x80041002\) && !SchemaStep/.test(api),'a failed lookup step is no missing DNS object');

// ---- The mapping ----
const refused=body(changes,'internal static Program.Outcome Refused(WmiException e, string objectName)');
ok(/ExistsCodes\.Contains\(e\.Code\)/.test(refused)&&/MissingCodes\.Contains\(e\.Code\)/.test(refused)&&/NoDirectoryCodes\.Contains\(e\.Code\)/.test(refused)&&/\["error"\] = e\.Code\.ToString/.test(refused),'Refused maps every failure by Code');
for(const name of ['error','call','hresult','provider','operation','detail','attempts','signature'])ok(refused.includes(`["${name}"]`),`Refused writes the arg ${name}`);
ok(refused.includes('"PLUGIN_DNS_CHANGE_FAILED_DETAIL"')&&refused.includes('"PLUGIN_DNS_CHANGE_FAILED"'),'Refused gives PLUGIN_DNS_CHANGE_FAILED_DETAIL with a description, else PLUGIN_DNS_CHANGE_FAILED');
ok(/Clean\(e\.Call, 200\)/.test(refused)&&/Clean\(e\.ProviderName, 100\)/.test(refused)&&/Clean\(e\.Operation, 100\)/.test(refused)&&/Clean\(e\.Description, 300\)/.test(refused)&&/, 1000\)/.test(refused),'every arg is cleaned and cut to its length');
ok(/Failed\(WmiException e\)[^\n]*\["error"\] = e\.Code\.ToString/.test(program)&&!/Failed\(WmiException e\)[^\n]*detail/.test(program),'Program.Failed reports Code only (reads unchanged)');

// ---- The zone create ----
const create=changes.slice(changes.indexOf('case "dns-zone-create":'),changes.indexOf('case "dns-zone-edit":'));
ok(/catch \(WmiException\)\s*\{[\s\S]*server\.Zones\(\)\.Any\([^\n]*DnsSnapshot\.Kind\(zone\.ZoneType\) == kind\)[\s\S]*if \(!created\) throw;/.test(create),'the zone-create apply reads Zones() again in a catch (WmiException) and checks the name and the kind');
ok(create.indexOf('server.SetZone(name, new ZoneSettings(Dynamic: dynamic))')>create.indexOf('if (!created) throw;'),'the dynamic-update step runs after a create that counted as done');
ok(create.includes('p.Only("kind", "lookup", "name", "networkId", "storage", "replicationScope", "fileName", "masters", "dynamicUpdate");')&&create.includes('if (ad && !server.IsDomainController()) throw new ChangeRefusedException("PLUGIN_DNS_NOT_DOMAIN_CONTROLLER");'),'the parsing of dns-zone-create and the AD check are unchanged');
ok(/if \(server\.Zones\(\)\.Any\(zone => DnsText\.Name\(zone\.Name\) == name\)\) throw new ChangeRefusedException\("PLUGIN_DNS_OBJECT_EXISTS", \("object", name\)\);/.test(create),'the pre-check refuses a zone of the merged list with PLUGIN_DNS_OBJECT_EXISTS');
const order=body(changes,'internal static void ModernFirst(string kind, Action modern, Action legacy, Func<bool> exists)');
ok(/if \(CimZoneClass\(kind\) is null\) \{ legacy\(\); return; \}/.test(order),'a kind without a modern class (a conditional forwarder) takes only the legacy call');
ok(order.indexOf('modern();')>=0&&order.indexOf('modern();')<order.indexOf('exists()')&&order.indexOf('exists()')<order.indexOf('legacy();',order.indexOf('modern();')),'the order is modern, existence check, legacy');
ok(/catch \(WmiException e\) when \(!IsDnsAnswer\(e\)\)/.test(order)&&/if \(present\) throw first;/.test(order)&&/throw Chosen\(first, second\)/.test(order),'a DNS answer or an existing zone stops before the legacy call; two failures throw the chosen one');
ok(/IsDnsAnswer\(WmiException e\) => e\.AccessDenied \|\| ExistsCodes\.Contains\(e\.Code\) \|\| MissingCodes\.Contains\(e\.Code\) \|\| NoDirectoryCodes\.Contains\(e\.Code\)/.test(changes),'a DNS answer is access denied or an exists, missing or no-directory code');
const chosen=body(changes,'internal static WmiException Chosen(params WmiException[] tried)');
ok(chosen.indexOf('ProviderCode is not null')<chosen.indexOf('Description')&&/\?\? tried\[0\]/.test(chosen)&&/chosen\.Attempts = tried;/.test(chosen),'the chosen exception: provider code first, then a description, else the first tried; it carries every attempt');
const zoneClassStart=changes.indexOf('internal static string? CimZoneClass(string kind) =>');
const zoneClass=zoneClassStart<0?'':changes.slice(zoneClassStart,changes.indexOf('\n',zoneClassStart));
ok(/"primary" => "PS_DnsServerPrimaryZone"/.test(zoneClass)&&/"secondary" => "PS_DnsServerSecondaryZone"/.test(zoneClass)&&/"stub" => "PS_DnsServerStubZone"/.test(zoneClass)&&/_ => null \}/.test(zoneClass)&&!/forwarder/.test(zoneClass),'only primary, secondary and stub have a modern class; a conditional forwarder has none');
ok(/server\.CreateZone\(name, "forwarder"/.test(changes),'the conditional-forwarder create uses kind forwarder, which ModernFirst keeps off the modern provider');
const wmiCreate=body(changes,'public void CreateZone(string name, string kind, bool ad, string? scope, string? fileName, string[] masters)\n    {\n        void Legacy()');
ok(/DnsChanges\.ModernFirst\(kind, \(\) => CreateZoneCim\(/.test(wmiCreate)&&/ZoneExists\(name\)/.test(wmiCreate),'WmiDnsServer.CreateZone goes through ModernFirst with the modern call, the legacy call and the existence check');
const legacy=body(wmiCreate,'void Legacy()');
ok(/Dns\.Call\("MicrosoftDNS_Zone", "MicrosoftDNS_Zone", "CreateZone"/.test(legacy)&&legacy.indexOf('SetScope(')>legacy.indexOf('"CreateZone"'),'the legacy call is MicrosoftDNS_Zone.CreateZone with today\'s values, then SetScope');
const cim=body(changes,'private static void CreateZoneCim(');
ok(/WmiConnection\.Open\(WmiConnection\.DnsCim\)/.test(cim)&&/cim\.Call\(className, className, method, values, checkReturn: true\)/.test(cim),'the modern create calls a static method of the class in root\\Microsoft\\Windows\\DNS');
ok(/"AddByAD"/.test(cim)&&/"AddByFile"/.test(cim)&&/"AddBy"/.test(cim)&&/"ForwardLookupZone"/.test(cim)&&/"ReverseLookupZone"/.test(cim),'the methods are AddByFile/AddByAD/AddBy + ForwardLookupZone/ReverseLookupZone');
ok(/\["Name"\] = name/.test(cim)&&/"NetworkID"/.test(cim)&&/"NetworkId"/.test(cim)&&/values\["ReplicationScope"\]/.test(cim)&&/values\["ZoneFile"\] = fileName/.test(cim)&&/values\["MasterServers"\] = masters/.test(cim),'name or network ID, storage and masters are typed method parameters');
ok(!/Query\(/.test(cim)&&!/Wql\./.test(cim)&&!/powershell/i.test(cim)&&!/Process/.test(cim),'the modern create builds no WQL text and runs no PowerShell or process');

// ---- The zone list and delete ----
const modernZones=body(changes,'private static List<RawZone> ModernZones()');
ok(/cim\.Query\("SELECT \* FROM DnsServerZone"\)/.test(modernZones)&&/DnsSnapshot\.ModernZone\(item\.Get\)/.test(modernZones)&&/catch \(WmiException\) \{ return \[\]; \}/.test(modernZones),'the modern zones come from one DnsServerZone query; a failure gives none');
const zones=body(changes,'internal IReadOnlyList<RawZone> Zones(bool countRecords)');
ok(/ModernZones\(\)/.test(zones)&&/"SELECT \* FROM MicrosoftDNS_Zone"/.test(zones)&&/DnsSnapshot\.MergeZones\(legacy, modern\)/.test(zones),'Zones() reads MicrosoftDNS_Zone and DnsServerZone and merges them');
ok((changes.match(/FROM DnsServerZone"\)/g)??[]).length===1&&!/Scopes\(\)/.test(changes),'a read runs one DnsServerZone query (no separate scope query)');
ok(/internal static RawZone\? ModernZone\(Func<string, object\?> get\)/.test(snapshot)&&/internal static List<RawZone> MergeZones\(IReadOnlyList<RawZone> legacy, IReadOnlyList<RawZone> modern\)/.test(snapshot),'the mapping and the merge are pure functions');
const modernZone=body(snapshot,'internal static RawZone? ModernZone(Func<string, object?> get)');
for(const property of ['ZoneName','ZoneType','IsReverseLookupZone','IsDsIntegrated','ReplicationScope','DirectoryPartitionName','ZoneFile','DynamicUpdate','SecureSecondaries','SecondaryServers','Notify','NotifyServers','MasterServers','ForwarderTimeout','IsPaused','IsAutoCreated'])ok(modernZone.includes(`"${property}"`),`ModernZone reads ${property}`);
ok(/"Cache", "Primary", "Secondary", "Stub", "Forwarder"/.test(modernZone),'ZoneType names map to the MicrosoftDNS_Zone numbers');
const deleteZone=body(changes,'public void DeleteZone(string zone)');
ok(/LegacyZonePath\(zone\) is not \{ \} path\) \{ DeleteZoneCim\(zone\); return; \}/.test(deleteZone)&&/DnsChanges\.LegacyFirst\(\(\) => Dns\.Delete\(path\), \(\) => DeleteZoneCim\(zone\)\)/.test(deleteZone),'a zone only DnsServerZone lists goes to the modern delete; a legacy zone is deleted as before, the modern delete after a generic failure');
const deleteCim=body(changes,'private static void DeleteZoneCim(string zone)');
ok(/WmiConnection\.Open\(WmiConnection\.DnsCim\)/.test(deleteCim)&&/cim\.Call\("PS_DnsServerZone", "PS_DnsServerZone", "Remove", new Dictionary<string, object\?> \{ \["Name"\] = zone, \["Force"\] = true \}, checkReturn: true\)/.test(deleteCim),'the modern delete is PS_DnsServerZone.Remove with Name and Force in root\\Microsoft\\Windows\\DNS');
const legacyFirst=body(changes,'internal static void LegacyFirst(Action legacy, Action modern)');
ok(/0x80041001/.test(legacyFirst)&&/!IsDnsAnswer\(e\)/.test(legacyFirst)&&/throw Chosen\(first, second\)/.test(legacyFirst),'the modern delete runs only after a generic legacy failure that is no DNS answer');
ok(/case "dns-zone-delete": case "dns-zone-transfer":[\s\S]{0,400}server\.Zones\(\)\.FirstOrDefault/.test(changes),'the delete check uses the merged zone list');

// ---- Version and changelog ----
ok(/Version = "1\.0\.4"/.test(program),'Program.cs: version 1.0.4');
ok(/\["PLUGIN_DNS_CHANGE_FAILED_DETAIL"\] = "The DNS server refused the change \(error \{error\}\)\. Windows reports: \{detail\} Check the values and try again\."/.test(program),'Program.cs has the template of PLUGIN_DNS_CHANGE_FAILED_DETAIL');
ok(/\["PLUGIN_DNS_CHANGE_FAILED"\] = "The DNS server refused the change \(error \{error\}\)\. Check the values and try again\."/.test(program),'the template of PLUGIN_DNS_CHANGE_FAILED is unchanged');
const csproj=read(`${dir}/ServerDesk.Plugin.Dns.csproj`);
ok(/<Version>1\.0\.4<\/Version>/.test(csproj)&&/<PluginMinAgentVersion>4\.21\.2<\/PluginMinAgentVersion>/.test(csproj),'csproj: version 1.0.4, minimum agent 4.21.2');
ok(/<PluginCapabilities>dns-read;dns-zone-read;dns-zone-create;dns-zone-edit;dns-zone-delete;dns-zone-transfer;dns-record-add;dns-record-edit;dns-record-delete;dns-conditional-create;dns-conditional-edit;dns-conditional-delete;dns-forwarders-set;dns-scavenging-set;dns-scavenge-now;dns-cache-clear<\/PluginCapabilities>/.test(csproj),'csproj: the capabilities are unchanged');
const changelog=JSON.parse(read(`${dir}/changelogs/1.0.4.json`));
ok(validateReleaseChangelog(changelog,'1.0.4').fixes.length===3,'changelogs/1.0.4.json passes the release-notes rules (at most 200 characters per entry)');
ok(changelog.version==='1.0.4'&&Array.isArray(changelog.features)&&changelog.features.length===0&&changelog.fixes.every(fix=>typeof fix==='string'&&fix.length>0&&fix.length<=200),'changelogs/1.0.4.json: version 1.0.4, no features, the fixes');
ok(/modern DNS/.test(changelog.fixes[0])&&/zone list/.test(changelog.fixes[1])&&/delete/.test(changelog.fixes[1])&&/Windows error text/.test(changelog.fixes[2]),'the fixes name the modern create, the zone list and delete, and the Windows error text');

// ---- Self-test cases ----
for(const label of ['a','b','c','d','e','f','g','h','i','j','k','l','m','n'])ok(new RegExp(`Check\\([\\s\\S]{0,1200}?"\\(${label}\\) `).test(selfTests),`DnsSelfTests.cs has the self-test case (${label})`);
ok(/ZoneCreateFailures\(\);/.test(selfTests)&&/ZoneProviders\(\);/.test(selfTests),'the self-test runs the zone-create and the provider cases');
ok(/DnsChanges\.ModernFirst\(kind,/.test(selfTests),'the in-memory server drives the same order function');

// ---- Documentation ----
const docs=read('docs/dns-server.md');
const sources=docs.slice(docs.indexOf('## Data sources'),docs.indexOf('## Reads'));
ok(sources.includes('`root\\Microsoft\\Windows\\DNS`')&&sources.includes('`PS_DnsServerPrimaryZone`')&&sources.includes('`MicrosoftDNS_Zone.CreateZone`')&&sources.includes('`PS_DnsServerZone`')&&sources.includes('`Remove`'),'"Data sources" names the modern create, its fallback and the modern delete');
ok(sources.indexOf('`PS_DnsServerPrimaryZone`')<sources.indexOf('fallback'),'"Data sources" names the modern class first and the classic call as the fallback');
ok(!/one time with the fallback/.test(sources)&&!/static method `CreateZone`/.test(sources),'the fallback text of 1.0.3 is replaced');
const codes=docs.slice(docs.indexOf('## Codes'),docs.indexOf('## Checks'));
ok(/`PLUGIN_DNS_READ_FAILED` \|[^\n]*error number of the DNS server when WMI gives one, else the WMI error number/.test(codes)&&/`PLUGIN_DNS_CHANGE_FAILED` \|[^\n]*error number of the DNS server when WMI gives one, else the WMI error number/.test(codes),'"Codes" names the DNS server error number');
ok(/`PLUGIN_DNS_CHANGE_FAILED_DETAIL` \|/.test(codes)&&/`attempts`/.test(codes)&&/`signature`/.test(codes),'"Codes" has PLUGIN_DNS_CHANGE_FAILED_DETAIL and names the args of a failed change');
console.log(`PASS DNS zone-create source (${checks} checks): the WMI error object with its provider code and texts, the lookup-step names, the mapping and the result args, the modern-first create with the classic fallback, the merged zone list and the modern delete, version 1.0.4, the self-test cases (a)-(n) and the documentation.`);
