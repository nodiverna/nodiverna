// Static checks of the tamper protection of agent 4.18.0 (agent/v3/NativeServiceSetup.cs,
// AgentIntegrity.cs, AgentBroker.cs, AgentWorker.cs, ServiceHost.cs, AgentInstaller.cs):
// the failure actions 5/30/60 s, reset 86400 s and the non-crash flag in one
// constant set, applied with SERVICE_START and verified on readback; the event
// kinds, targets, services, start types and reasons equal the portal contract
// (lib/agent-integrity-contract.ts, re-exported by lib/server/agent/agent-integrity.ts); the
// planned contexts guard the events and the watchdog; the watchdog never starts
// a worker set to manual or disabled; the worker never starts or ends the broker;
// ServiceHost passes STOP or SHUTDOWN; only a local uninstall posts; the
// capability; the two self-tests in Program.cs, the build and the pipeline; the
// version and its changelog; and the docs sections. Code without comments; no build.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
// Code without comments, so that a comment that names a call does not count.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/(^|[^:"])\/\/.*$/,'$1')).join('\n');
const setup=code('agent/v3/NativeServiceSetup.cs'),integrity=code('agent/v3/AgentIntegrity.cs'),broker=code('agent/v3/AgentBroker.cs'),worker=code('agent/v3/AgentWorker.cs'),host=code('agent/v3/ServiceHost.cs'),installer=code('agent/v3/AgentInstaller.cs'),protocol=code('agent/v3/BrokerProtocol.cs'),program=read('agent/v3/Program.cs'),build=read('scripts/build-agent-v3.mjs');
const body=(source,signature)=>{const start=source.indexOf(signature);assert.ok(start>=0,`missing ${signature}`);let depth=0,index=source.indexOf('{',start);const from=index;for(;index<source.length;index++){if(source[index]==='{')depth++;else if(source[index]==='}'&&--depth===0)break;}return source.slice(from,index+1);};

// ---- Recovery: one constant set, applied with SERVICE_START, verified ----
ok(/internal static readonly uint\[\] RecoveryDelaysMs = \[5000, 30000, 60000\]; internal const uint RecoveryResetSeconds = 86400; internal const bool RecoveryOnNonCrashFailures = true;/.test(setup),'the failure actions 5000/30000/60000 ms, reset 86400 s and the flag true in one constant set');
ok(!/Delay = 60000|ResetPeriod = 86400/.test(setup),'no second, literal set of failure actions');
ok(/ServiceStart = 0x0010/.test(setup)&&/SecurityPolicyAccess = ServiceQueryConfig \| ServiceChangeConfig \| ServiceStart \| ReadControl \| WriteDacl \| WriteOwner;/.test(setup),'SERVICE_START is in the access of the handle that sets the failure actions');
const apply=body(setup,'private static void ApplySecurityPolicy(IntPtr service, string name, AgentServiceNames names)');
ok(/ApplyRecovery\(service\);\s*VerifyAppliedSecurityPolicy\(service, sidType\);/.test(apply),'the policy repair sets the failure actions, then verifies');
ok(/SetConfig\(service, FailureActionsLevel, new FailureActions \{ ResetPeriod = RecoveryResetSeconds, Count = \(uint\)RecoveryDelaysMs\.Length/.test(body(setup,'private static void ApplyRecovery(IntPtr service)'))&&/FailureActionsFlagLevel, new FailureActionsFlag \{ OnNonCrashFailures = RecoveryOnNonCrashFailures \}/.test(setup),'ApplyRecovery uses the constant set');
const verify=body(setup,'private static void VerifyAppliedSecurityPolicy(IntPtr service, uint sidType)');
ok(/ReadRecovery\(service\)/.test(verify)&&/RecoveryDifference\(reset, actions, flag\) is string difference\) throw new IOException/.test(verify),'VerifyAppliedSecurityPolicy reads back the failure actions and the flag and throws IOException on a difference');
ok(/QueryServiceConfig2W\(service, FailureActionsLevel/.test(setup)&&/QueryServiceConfig2W\(service, FailureActionsFlagLevel/.test(setup),'SERVICE_CONFIG_FAILURE_ACTIONS and SERVICE_CONFIG_FAILURE_ACTIONS_FLAG are read');
ok(/ApplySecurityPolicy\(service, name, names\);/.test(body(setup,'private static void ConfigureService(')),'Configure (install, repair, rollback) applies the same policy');
ok(/internal static void ApplySecurityPolicy\(\) => ApplySecurityPolicy\(AgentServiceNames\.Installed\);/.test(setup),'the broker start repair applies the same policy');
ok(/NativeServiceSetup\.ApplySecurityPolicy\(names\)/.test(integrity)&&/Check\(report: reports, applyPolicy: true\);/.test(integrity),'the broker integrity start applies the policy at every start');
ok(/repairPolicy: false\);/.test(program.split('"--broker")')[1]??'')&&/integrity\.Start\(\); return new AgentBroker\(root, integrity\)\.RunAsync\(stop\);/.test(program),'the broker checks before it repairs (ServiceHost does not repair first)');
ok(/"O:BAD:P\(A;;0xF01FF;;;SY\)\(A;;0xF01FF;;;BA\)\(A;;0x2008D;;;AU\)"/.test(setup)&&!/\(D;/.test(setup),'SYSTEM and Administrators keep full control; no ACE denies anyone');
ok(/NativeInstallerTests|RecoveryDifference/.test(read('agent/v3/NativeInstallerTests.cs'))&&/VerifyRecoveryComparison\(\);/.test(read('agent/v3/NativeInstallerTests.cs')),'the installer self-test covers the comparison');

// ---- The contract equals the portal ----
const contract=await import('../../lib/agent-integrity-contract.ts');
const csList=name=>{const match=new RegExp(`internal static readonly string\\[\\] ${name} = \\[([^\\]]*)\\];`).exec(integrity);assert.ok(match,`IntegrityContract.${name}`);return JSON.parse('['+match[1]+']');};
for(const [cs,ts] of [['Kinds','AGENT_INTEGRITY_KINDS'],['Targets','AGENT_INTEGRITY_TARGETS'],['Services','AGENT_INTEGRITY_SERVICES'],['StartTypes','AGENT_START_TYPES'],['EventStartTypes','AGENT_INTEGRITY_EVENT_START_TYPES'],['Reasons','AGENT_INTEGRITY_REASONS'],['StopKinds','AGENT_INTEGRITY_STOP_KINDS']])
 ok(JSON.stringify(csList(cs))===JSON.stringify([...contract[ts]]),`IntegrityContract.${cs} equals ${ts}`);
const route=read('lib/server/agent/agent-integrity.ts');
ok(/export \{AGENT_INTEGRITY_EVENT_START_TYPES,AGENT_INTEGRITY_KINDS,AGENT_INTEGRITY_REASONS,AGENT_INTEGRITY_RETENTION_MS,AGENT_INTEGRITY_SERVICES,AGENT_INTEGRITY_STOP_KINDS,AGENT_INTEGRITY_TARGETS,AGENT_INTEGRITY_WINDOW_MS\};/.test(route),'lib/server/agent/agent-integrity.ts exports the contract lists');
ok(/internal const int FindingLength = 120, UserLength = 256;/.test(integrity)&&/finding:z\.string\(\)\.max\(120\)/.test(route)&&/user:z\.string\(\)\.min\(1\)\.max\(256\)/.test(route),'the finding (120) and user (256) bounds match');
ok(/internal const string Route = "\/api\/agent\/integrity";/.test(integrity)&&existsSync('app/api/agent/integrity/route.ts'),'the route');

// ---- Planned contexts guard the events and the watchdog ----
ok(/internal static bool Planned\(bool shutdown, bool maintenance, bool updatePending, bool updating, bool uninstallBusy\) => shutdown \|\| maintenance \|\| updatePending \|\| updating \|\| uninstallBusy;/.test(integrity),'the five planned contexts');
ok(/integrity\.Attach\(\(\) => PlannedContext\.Planned\(serviceStop\?\.Shutdown == true, AgentInstaller\.InMaintenance\(root\), AgentUpdater\.Pending\(root\), jobs\.Updating, jobs\.Uninstall\.Busy\)\);/.test(broker),'the broker gives its full planned context: shutdown, maintenance, update plan, update job and portal uninstall');
const tick=body(integrity,'internal void Tick(bool stopping)');
ok(/bool isPlanned = Planned\(\);/.test(tick)&&/if \(due && !isPlanned\)/.test(tick)&&/Watch\(isPlanned \|\| PlannedContext\.SystemShuttingDown\(\)\)/.test(tick),'the periodic check and the watchdog wait for planned contexts');
const watch=body(integrity,'private void Watch(bool isPlanned)');
ok(/&& !isPlanned\) Events\.Add\(IntegrityContract\.Event\("service-ended"/.test(watch)&&/if \(isPlanned\) \{ stoppedChecks = 0; NoteRequest\(\); return; \}/.test(watch)&&/WorkerWatchdog\.Decide\(state, startType, since, isPlanned, stoppedChecks\)/.test(watch),'the watchdog creates no event and takes no action in a planned context');
ok(/else if \(stop\.Stopped && !Planned\(\) && !PlannedContext\.SystemShuttingDown\(\)\) Events\.Add\(IntegrityContract\.Event\("service-stopped", clock\(\), service: "broker"\)\);/.test(body(integrity,'internal void Stopped(ServiceStop stop)')),'a broker STOP is queued only outside a planned context, never on SHUTDOWN');
ok(/RunMarker\.Ended\(ReadJson\(markerPath\), boot, atStartPlanned\)/.test(integrity),'the run marker gives service-ended only outside a planned context');
ok(/internal static JsonObject\? StopEvent\(bool planned, bool deleted, DateTimeOffset now\) =>\s*planned \? null/.test(integrity),'the worker posts nothing on a planned stop');

// ---- The watchdog never starts a manual or disabled worker; the worker never starts or ends the broker ----
const decide=body(integrity,'internal static WatchdogAction Decide(');
ok(/if \(planned\) return WatchdogAction\.None;/.test(decide)&&/stoppedChecks >= 2 && startType is "auto" or "delayed-auto" \? WatchdogAction\.Start : WatchdogAction\.None/.test(decide),'the watchdog starts only an automatic worker after two stopped checks');
ok(/HangLimit = TimeSpan\.FromMinutes\(3\)/.test(integrity)&&/Interval = TimeSpan\.FromSeconds\(15\)/.test(integrity),'15 s checks, 3 minutes without a request');
ok(/WindowsService\.Start\(names\.Worker\)/.test(watch)&&!/WindowsService\.Start\(names\.Broker\)|BrokerService/.test(watch),'the watchdog starts only the worker');
ok(/WindowsService\.Query\(names\.Worker\)\.ProcessId == pid/.test(watch),'it ends only the process the SCM runs as the worker');
for(const forbidden of ['WindowsService.Start','WindowsService.StopAsync','.Kill(','StartServiceW','ControlService','Process.Start'])ok(!worker.includes(forbidden),`the worker never calls ${forbidden}`);
ok(/BrokerUnresponsive\(TimeSpan sinceLastAnswer, bool reported\) => !reported && sinceLastAnswer >= BrokerOutage;/.test(integrity)&&/BrokerOutage = TimeSpan\.FromMinutes\(3\)/.test(integrity),'broker-unresponsive after 3 minutes, once per outage');

// ---- ServiceHost passes STOP or SHUTDOWN; the worker's last message ----
ok(/internal const int StopControl = 1, ShutdownControl = 5;/.test(host)&&/stop\.Record\(control\); Report\(3\); cancel\.Cancel\(\);/.test(host)&&/internal static int Run\(string name, Func<ServiceStop, Task> work/.test(host),'ServiceHost records STOP or SHUTDOWN before it cancels the work');
ok(/WaitHintMilliseconds = 15000/.test(host)&&/StopContextTimeout = TimeSpan\.FromSeconds\(2\), StopPostBudget = TimeSpan\.FromSeconds\(5\)/.test(integrity),'2 s for the stop context and 5 s for the post fit the 15 s wait hint');
const stopping=body(worker,'private async Task StoppingAsync(ServiceStop service)');
ok(/if \(service\.Stopped\)/.test(stopping)&&/"op"\] = "stop-context"/.test(stopping)&&/WorkerIntegrity\.MarkedForDeletion\(\)/.test(stopping)&&/"op"\] = "worker-stopping"/.test(stopping),'on STOP the worker asks the stop context, reads the delete flag, posts, and always sends worker-stopping');
ok(/"DeleteFlag"/.test(integrity),'the delete flag of the service registry key');
ok(/case "stop-context":/.test(broker)&&/case "worker-stopping":/.test(broker)&&/case "integrity-ack":/.test(broker),'the three new broker operations');
ok(/internal static bool IsReadOnly\(string\? op\) => op is "telemetry" or "status";/.test(protocol),'integrity-ack is not a read-only operation');
ok(/\["integrity"\] = integrity\.Snapshot\(\), \["integrityEvents"\] = integrity\.Events\.Pending\(\)/.test(broker)&&/state\["integrityPending"\] = true/.test(broker),'status and channel-state carry the integrity fields');
ok(/internal const int Maximum = 50, PendingLimit = 20;/.test(integrity)&&/"integrity-events\.json"/.test(integrity),'at most 50 stored, 20 pending events in integrity-events.json');

// ---- Local uninstall, capability ----
const uninstall=body(installer,'internal static async Task<int> UninstallAsync(string root, bool detached = false)');
ok(/if \(!detached\) await WorkerIntegrity\.ReportLocalUninstallAsync\(root, Console\.WriteLine\);/.test(uninstall),'only a local uninstall (not detached) posts agent-removed');
ok(uninstall.indexOf('ReportLocalUninstallAsync')<uninstall.indexOf('WindowsService.StopAsync')&&uninstall.indexOf('MarkMaintenance(root)')<uninstall.indexOf('ReportLocalUninstallAsync'),'it posts under the maintenance marker, before it stops or removes anything');
ok(/TimeSpan\.FromSeconds\(10\)/.test(body(integrity,'internal static async Task<bool> ReportLocalUninstallAsync('))&&/stateDirectory: null/.test(integrity),'within 10 s with an in-memory device token client');
ok(/File\.Delete\(Path\.Combine\(root, IntegrityBaseline\.FileName\)\);/.test(installer),'--install drops the baseline, so the next start repairs silently');
ok(/internal const string Capability = "agent-integrity";/.test(integrity)&&/IntegrityContract\.Capability \}\)/.test(worker),'the capability agent-integrity');

// ---- Self-tests, build, pipeline ----
ok(/args\[0\] == "--integrity-self-test"\) return AgentIntegrityTests\.RunSelfTest\(\);/.test(program)&&/args\[0\] == "--service-lifecycle-self-test"\) return await ServiceLifecycleTests\.RunSelfTestAsync\(\);/.test(program)&&/args\[0\] == "--lifecycle-probe"\) return ServiceLifecycleTests\.RunProbe\(args\[1\]\);/.test(program),'Program.cs registers both self-tests and the probe');
ok(build.includes("'--plugin-self-test','--integrity-self-test'])")&&/spawnSync\(command,\[\.\.\.prefix,'--service-lifecycle-self-test'\]/.test(build),'the build runs both self-tests, the lifecycle test after the others');
ok(/lifecycle\.status===2\)\{if\(process\.env\.SERVERDESK_AGENT_LIFECYCLE_TEST==='required'\)throw/.test(build),'exit 2 fails the build only when the test is required');
ok(/SERVERDESK_AGENT_SMOKE_MODE: native\r?\n\s+SERVERDESK_AGENT_LIFECYCLE_TEST: required\r?\n/.test(read('../.github/workflows/agent-release.yml')),'the Agent release workflow requires the lifecycle self-test');
const lifecycle=code('agent/v3/ServiceLifecycleTests.cs');
ok(/new\("ServerDeskSelfTest", "ServerDeskSelfTestWorker"\)/.test(lifecycle)&&/NativeServiceSetup\.Configure\(Names,/.test(lifecycle)&&/NativeServiceSetup\.Delete\(Names\)/.test(lifecycle)&&/finally\s*\{\s*try \{ await RemoveAsync\(root\); \}/.test(lifecycle)&&/return Skipped;/.test(lifecycle),'the lifecycle test uses the real setup with test names, cleans up in finally and skips without elevation');

// ---- Version and changelog ----
const version=/internal const string BaseVersion = "(\d+)\.(\d+)\.(\d+)";/.exec(program).slice(1).map(Number);
ok(version[0]>4||version[0]===4&&(version[1]>17||version[1]===17&&version[2]>0),'the version is above 4.17.0');
const text=version.join('.');
ok(read('agent/v3/ServerDesk.Agent.csproj').includes(`<Version>${text}</Version>`)&&existsSync(`agent/v3/changelogs/${text}.json`),'the csproj and the changelog of '+text);

// ---- Docs ----
const native=read('docs/native-agent-v4.md');
ok(/^## Tamper protection in 4\.\d+\.\d+$/m.test(native)&&/^## Remove the agent by hand$/m.test(native),'docs/native-agent-v4.md has both sections');
const manual=native.slice(native.indexOf('## Remove the agent by hand'));
const disable=manual.indexOf('sc.exe config ServerDeskWorker start= disabled'),deleteWorker=manual.indexOf('sc.exe delete ServerDeskWorker');
ok(disable>0&&manual.includes('sc.exe config ServerDeskAgent start= disabled')&&deleteWorker>disable&&manual.indexOf('sc.exe delete ServerDeskAgent')>deleteWorker,'sc.exe config … start= disabled comes before sc.exe delete, the worker before the broker');
for(const part of ['ServerDesk Update Recovery','ServerDesk-Uninstall-*','ServerDesk Plugin *','ServerDesk RTC *','HKLM\\SYSTEM\\CurrentControlSet\\Services\\ServerDeskAgent','Event Log Readers','Safe Mode','Remove the device in the portal'])ok(manual.includes(part),'the removal names '+part);
ok(/^## Watchdog$/m.test(read('docs/agent-broker-worker.md')),'docs/agent-broker-worker.md: the watchdog');
ok(/^### Agent tamper protection$/m.test(read('docs/alert-rules.md'))&&read('docs/alert-rules.md').includes('There are 38 fixed rules'),'docs/alert-rules.md: the three rules');
ok(read('agent/v3/README.md').includes('docs/native-agent-v4.md#remove-the-agent-by-hand'),'the README links to the removal by hand');
console.log(`PASS agent integrity source (${checks} checks): failure actions in one constant set with SERVICE_START and readback, the contract equals the portal, planned contexts, a watchdog that never starts a manual or disabled worker, a worker that never starts or ends the broker, the stop reason, the local uninstall post, the capability, the self-tests in the build and the Agent release workflow, the version and the docs.`);
