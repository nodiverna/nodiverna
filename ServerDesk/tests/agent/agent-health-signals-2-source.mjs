// Static checks of the agent sources of health signals 2 (agent 4.11.0): the
// certificate collector never touches a private key or raw certificate data and
// opens the stores read-only, the driver collector never puts a device ID into
// its result, the autostart collector masks command lines before it hashes them,
// the five collectors are fixed privileged broker reads with their own deadline,
// and the self-tests are registered. Agent 4.11.1: the driver read uses no WMI,
// the privileged broker call timeout follows the collector's deadline, and the
// broker logs every failed telemetry read. Agent 4.13.2: the terminal, relay and
// channel loops back off while the broker is down, and a stale broker pipe gets
// one retry on a fresh pipe. No database, no build.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
// Code without comments, so that a comment that names a forbidden call does not count.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/\/\/.*$/,'')).join('\n');
const certificates=code('agent/v3/NativeCertificates.cs'),drivers=code('agent/v3/NativeDriverInventory.cs'),autostart=code('agent/v3/NativeAutostartInventory.cs');
const telemetry=read('agent/v3/NativeTelemetry.cs'),broker=read('agent/v3/AgentBroker.cs'),worker=code('agent/v3/AgentWorker.cs'),program=read('agent/v3/Program.cs'),build=read('scripts/build-agent-v3.mjs'),mask=read('agent/v3/SecretMask.cs');
const providers=['Drivers','Reliability','Disk and battery health','Certificates','Autostart'];

// ---- Certificates ----
for(const name of ['PrivateKey','GetRSAPrivateKey','GetECDsaPrivateKey','GetDSAPrivateKey','GetECDiffieHellmanPrivateKey','CopyWithPrivateKey','Export','ExportCertificatePem','ExportPkcs12','RawData','RawDataMemory','GetRawCertData','GetRawCertDataString'])
 ok(!new RegExp(String.raw`(?<![A-Za-z])${name}\b`).test(certificates.replace(/\bHasPrivateKey\b/g,'')),`the certificate source never names ${name}`);
// The marker is split so that the repository scan of tests/repo/key-material.mjs does not match this file.
ok(!new RegExp('BEGIN (?:CERTIFICATE|PRIVATE'+' KEY)|Convert\.ToBase64String').test(certificates),'the certificate source builds no PEM or base64 data');
ok(/\.HasPrivateKey\b/.test(certificates),'it reads only whether a private key exists');
ok(/OpenFlags\.ReadOnly \| OpenFlags\.OpenExistingOnly/.test(certificates)&&!/OpenFlags\.(?:ReadWrite|MaxAllowed)/.test(certificates),'it opens the stores read-only and only when they exist');
ok(!/\.(?:Add|Remove|RemoveRange|AddRange)\(\s*certificate/.test(certificates),'it never changes a store');
for(const store of ['"My"','"WebHosting"','"Remote Desktop"'])ok(certificates.includes(store),`it reads the store ${store}`);
ok(/StoreLocation\.LocalMachine/.test(certificates)&&!/StoreLocation\.CurrentUser/.test(certificates),'only the machine stores');

// ---- Drivers ----
ok(!/\["(?:pnpDeviceId|PNPDeviceID|deviceId|DeviceID|instanceId)"\]\s*=/.test(drivers),'the driver source puts no device ID field into a result');
ok(/\["key"\] = DeviceKey\(id\)/.test(drivers)&&/string key = DeviceKey\(id\)/.test(drivers),'problem devices and drivers carry only the hash of the device ID');
ok(!/new DriverEntry\(\s*id\b/.test(drivers)&&!/\] = id\b/.test(drivers),'the raw ID never becomes a value');
ok(/SHA256\.HashData/.test(drivers),'the key is a SHA-256 hash');
for(const name of ['Win32_PnPSignedDriver','Win32_SystemDriver','Win32_PnPEntity','ManagementObjectSearcher','WindowsManagement.Query'])ok(!drivers.includes(name),`the driver source uses no WMI: no ${name}`);
for(const name of ['CM_Get_Device_ID_List_SizeW','CM_Get_Device_ID_ListW','CM_Locate_DevNodeW','CM_Get_DevNode_Status','CM_Get_DevNode_PropertyW'])ok(drivers.includes(name),`the driver source reads devices through ${name}`);
ok(/PresentFilter = 0x00000100/.test(drivers),'only present devices');
ok(/internal const int DeadlineSeconds = 45;/.test(drivers)&&/internal const int SignatureBudgetSeconds = 20;/.test(drivers)&&/BrokerCallSeconds => AgentWorker\.PrivilegedCallSeconds\(DeadlineSeconds\)/.test(drivers),'the driver budgets live in the constants of NativeDriverInventory');

// ---- Autostart ----
ok(/internal static string CommandLine\(string text, IEnumerable<string> knownSecrets\)/.test(mask),'SecretMask.CommandLine exists');
ok(/cleanCommand = Short\(Scrub\(SecretMask\.CommandLine\(/.test(autostart),'the autostart command is masked and scrubbed');
ok(/new AutostartEntry\(Id\(category, scope, cleanLocation, cleanName, cleanCommand\), category, scope, cleanLocation, cleanName, cleanCommand,/.test(autostart),'the ID and the sent command use the masked, scrubbed command');
ok(/bool userPath = resolved is not null && IsUserPath\(resolved\)/.test(autostart)&&autostart.indexOf('bool userPath')<autostart.indexOf('cleanCommand ='),'userPath is decided before scrubbing');
ok(!/RegLoadKey|RegLoadAppKey|LoadKey\(/.test(autostart),'the autostart source never loads a hive');

// ---- Providers and broker ----
for(const name of providers){
 ok(new RegExp(String.raw`PrivilegedProviders = \[[^\]]*"${name}"`).test(telemetry),`${name} is a privileged provider`);
 ok(broker.includes(`"${name}" => `),`${name} is a fixed case of the broker switch`);
 ok(new RegExp(String.raw`Add\("${name}", \w+\.IntervalSeconds, new \w+\(\)\.Collect, \w+\.DeadlineSeconds(?:, keepLastValue: true)?\)`).test(telemetry),`${name} has its own interval and deadline`);
}

ok(/Add\("Drivers", [^;]*keepLastValue: true\)/.test(telemetry),'the driver list is kept until the next success');

// ---- Agent 4.11.1: broker call timeout and failure log ----
const privileged=worker.slice(worker.indexOf('private JsonObject Privileged('),worker.indexOf('private static JsonArray Signed('));
ok(privileged.length>0&&!/,\s*45\s*,/.test(privileged)&&/PrivilegedCallSeconds\(deadlineSeconds\)/.test(privileged),'AgentWorker.Privileged uses the collector deadline, no fixed 45 for every collector');
ok(/Math\.Max\(MinimumPrivilegedCallSeconds, deadlineSeconds \+ 15\)/.test(worker),'the call timeout is max(45, deadline + 15)');
const handle=broker.slice(broker.indexOf('private async Task HandleAsync('),broker.indexOf('private void Authenticate('));
ok(/"telemetry"\) Log\(BrokerTelemetry\.FailureLine/.test(handle),'every failed telemetry read is logged');
ok(handle.indexOf('BrokerTelemetry.FailureLine')>0&&handle.indexOf('BrokerTelemetry.FailureLine')<handle.indexOf('else if (e is not (BrokerException or TimeoutException))'),'TimeoutException is no longer excluded from the telemetry log; only other ops keep that filter');
ok(/BrokerProtocol\.Failure\(e, watch\.ElapsedMilliseconds\)/.test(handle),'the failure reply carries type, detail, code and elapsed time');

// ---- Agent 4.13.2: broker backoff and one retry on a stale broker pipe ----
const between=(text,from,to)=>{const start=text.indexOf(from),end=text.indexOf(to,start+1);assert.ok(start>=0&&end>start,`${from} … ${to} found`);return text.slice(start,end);};
const relayLoop=between(worker,'private async Task RelayLoopAsync(','private async Task ExecuteRelayAsync(');
ok(/var backoff = new PortalRetryBackoff\(\);/.test(relayLoop)&&/\["op"\] = "relay-take"[^;]*;\s*backoff\.Success\(\);/.test(relayLoop),'RelayLoopAsync has its own PortalRetryBackoff, and a successful relay-take resets it');
ok(/if \(retry\.Log\) LogSafe\("Broker relay: " \+ e\.Message\);/.test(relayLoop)&&/await Task\.Delay\(Math\.Max\(1000, retry\.DelayMs\), token\);/.test(relayLoop)&&!/Task\.Delay\(1000, token\)/.test(relayLoop),'the relay loop waits max(1000, backoff) and logs only when the backoff allows it');
const terminalLoop=between(worker,'private async Task TerminalLoopAsync(','private async Task RelayLoopAsync(');
ok(/if \(retry\.Log\) LogSafe\("Terminal channel: " \+ Describe\(e\)\);/.test(terminalLoop)&&/Task\.Delay\(Math\.Max\(1000, retryDelay\), token\)/.test(terminalLoop),'the terminal loop waits max(1000, backoff) and logs only when the backoff allows it');
const channelLoop=between(worker,'private async Task ChannelLoopAsync(','private async Task TerminalLoopAsync(');
ok(/if \(retry\.Log\) LogSafe\("Channel: " \+ Describe\(e\)\);/.test(channelLoop)&&/interval = Math\.Max\(interval, retry\.DelayMs\);/.test(channelLoop)&&/UninstallChannel\.BrokerSignal\(e, uninstallJob\)/.test(channelLoop),'the channel loop keeps max(interval, backoff) and its uninstall signal');
const transient=between(worker,'internal static bool IsTransient(','internal (int DelayMs, bool Log) Failed(');
ok(/BrokerUnavailableException => true,/.test(transient)&&/BrokerException broker => broker\.Code == CollectorErrorCodes\.BrokerUnavailable,/.test(transient)&&!/TimeoutException/.test(transient),'IsTransient names BrokerUnavailableException and a refused hello, not a broker timeout');
ok(/Task\.Delay\(30000, token\)/.test(between(worker,'private async Task HeartbeatLoopAsync(','private async Task UploadListAsync(')),'the heartbeat period stays 30 s');
ok(/catch \(Exception e\) when \(!token\.IsCancellationRequested\) \{ LogSafe\("Broker relay reply: " \+ e\.Message\); \}/.test(between(worker,'private async Task ExecuteRelayAsync(','internal Task<JsonObject> PostAsync(')),'Broker relay reply: stays one line per failed reply');
const protocol=code('agent/v3/BrokerProtocol.cs'),callAsync=between(protocol,'internal async Task<JsonObject> CallAsync(','internal static string? Text(');
ok(/bool reused = attempt == 0 && owner\.Stream is not null, written = false;/.test(callAsync)&&callAsync.indexOf('bool reused')<callAsync.indexOf('owner.Stream ??= await opener('),'CallAsync notes a reused stream before it opens one, and only on the first attempt');
ok(/await BrokerProtocol\.WriteAsync\(owner\.Stream, request, deadline\.Token\);\s*written = true;/.test(callAsync),'CallAsync notes a complete write');
ok(/if \(reused && e is IOException && !deadline\.IsCancellationRequested && \(!written \|\| readOnly\)\) continue;/.test(callAsync)&&(callAsync.match(/continue;/g)||[]).length===1,'the one retry path: a reused stream, an IOException, inside the deadline, and a failed write or a read-only op');
ok(callAsync.indexOf('throw new TimeoutException(')<callAsync.indexOf('continue;')&&/catch \(Exception e\) when \(e is not BrokerException\)/.test(callAsync),'a timeout and a broker reply never retry');
ok(/internal static bool IsReadOnly\(string\? op\) => op is "telemetry" or "status";/.test(protocol),'only telemetry and status are read-only');
ok(/internal BrokerClient\(\) : this\(null\) \{ \}/.test(protocol)&&/this\.opener = opener \?\? OpenAsync;/.test(protocol),'new BrokerClient() opens the broker pipe; the opener is a test seam');

// ---- Self-tests ----
for(const test of ['--failure-paths-self-test','--drivers-self-test','--reliability-self-test','--disk-health-self-test','--certificates-self-test','--autostart-self-test']){
 ok(program.includes(`args[0] == "${test}"`),`${test} is a Program.cs switch`);
 ok(build.includes(`'${test}'`),`${test} runs in scripts/build-agent-v3.mjs`);
}

console.log(`PASS agent health signals 2 sources (${checks} checks): no private key or raw certificate access, read-only machine stores, no device ID in the driver result, no WMI in the driver read, masked autostart commands, five privileged broker reads with own deadlines and call timeouts, the telemetry failure log, the broker backoff, the single stale-pipe retry and registered self-tests.`);
