// Static checks of the agent sources of GPU driver updates (agent 4.13.0):
// the download host allow list is a constant in agent and worker, the relay kind
// is fixed, every signature of the staged file is checked with WinVerifyTrust
// and the signer pin comes from the verified state (4.17.1), the registry of
// open downloads never disposes in the stale purge (4.17.1),
// the installer runs directly with fixed arguments and without a shell, the
// staging is cleaned up after every outcome, NVML reloads after a driver
// change (4.17.2), the capability is a management
// action and never a read, and the self-test is registered. No build.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
// Code without comments, so that a comment that names a forbidden call does not
// count. A line comment starts the line or follows a space, so URLs in strings stay.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/(^|\s)\/\/.*$/,'$1')).join('\n');
const update=code('agent/v3/GpuDriverUpdate.cs'),relay=code('agent/v3/WorkerRelay.cs'),runner=code('agent/v3/JobRunner.cs'),management=code('agent/v3/NativeManagement.cs');
const program=read('agent/v3/Program.cs'),build=read('scripts/build-agent-v3.mjs'),readme=read('agent/v3/README.md'),broker=code('agent/v3/AgentBroker.cs'),details=code('agent/v3/NativeGpuDetails.cs');
const portal=read('lib/server/devices/gpu-drivers/catalog.ts');

// ---- Host allow list: an agent constant, used by the job validation and by the worker ----
ok(/internal static readonly IReadOnlyDictionary<string, string\[\]> AllowedHosts = new Dictionary<string, string\[\]>\(StringComparer\.Ordinal\)\s*\{\s*\["nvidia"\] = \["us\.download\.nvidia\.com", "international\.download\.nvidia\.com"\],\s*\["amd"\] = \["drivers\.amd\.com"\],\s*\};/.test(update),'the agent allow list is a constant with the three vendor hosts');
ok(/nvidia:\['us\.download\.nvidia\.com','international\.download\.nvidia\.com'\],amd:\['drivers\.amd\.com'\]/.test(portal),'the portal has the same download hosts');
ok(/uri\.Scheme == Uri\.UriSchemeHttps && uri\.UserInfo\.Length == 0 && uri\.IsDefaultPort/.test(update),'https, no user info, default port');
ok(/var uri = ParseUrl\(vendor, url\) \?\? throw new AgentMessageException\("AGENT_GPU_DRIVER_INVALID"\)/.test(update),'the job URL must pass the allow list');
ok(/size is not \(>= 1 and <= MaximumBytes\)/.test(update)&&/internal const long MaximumBytes = 3L \* 1024 \* 1024 \* 1024;/.test(update),'the size is between 1 byte and 3 GiB');
ok(/if \(!GpuDriverUpdate\.AllowedUrl\(vendor, url\)\) throw/.test(relay),'the worker checks the allow list again');
ok(/!GpuDriverUpdate\.AllowedUrl\(vendor, next\.AbsoluteUri\)/.test(relay)&&/AllowAutoRedirect = false/.test(relay),'every redirect hop is checked; no automatic redirects');
ok(/if \(vendor == "amd"\) message\.Headers\.Referrer = new Uri\(GpuDriverUpdate\.AmdReferer\);/.test(relay)&&/internal const string AmdReferer = "https:\/\/www\.amd\.com\/";/.test(update),'the AMD download sends the AMD site as Referer');
ok(/ContentLength is long declared && declared != size/.test(relay)&&/if \(total > size\)/.test(relay)&&/if \(total != size\)/.test(relay),'the declared and the received length must equal the job size');
ok(/"gpu-" \+ handle \+ "\.part"/.test(relay),'the worker writes a .part file');
ok(/gpuDrivers\.Add\(handle, path, GpuDriverUpdate\.DownloadLimit, token\)/.test(relay)&&/stop\.CancelAfter\(limit\)/.test(relay)&&/DownloadLimit = TimeSpan\.FromMinutes\(30\)/.test(update),'the download has 30 minutes');
ok(!/vendors\.DefaultRequestHeaders\.Authorization|DeviceAuthorizationHandler/.test(relay.slice(relay.indexOf('vendors = new HttpClient'),relay.indexOf('vendors = new HttpClient')+300)),'vendor requests carry no device token');

// ---- The fixed relay kinds ----
for(const kind of ['gpu-driver-open','gpu-driver-read','gpu-driver-close'])ok(relay.includes(`case "${kind}":`)&&relay.includes(`["kind"] = "${kind}"`),`the relay kind ${kind} is fixed on both sides`);
ok(/default: throw new InvalidDataException\("Unsupported relay request\."\);/.test(relay),'any other kind is refused');
ok(/new RelayGpuDriverSource\(relay\)/.test(broker),'the broker downloads through the relay');

// ---- Staging, hash and signature ----
ok(/StagingFiles\.CreateNew\(folder, secure: true\); StagingFiles\.VerifyNew\(folder, secure: true\);/.test(update),'the staging folder is SYSTEM and Administrators only, checked through a handle');
ok(/IncrementalHash\.CreateHash\(HashAlgorithmName\.SHA256\)/.test(update)&&/hash\.AppendData\(data\)/.test(relay),'the broker hashes while it copies');
ok(/using var pinned = StagingFiles\.Pin\(folder, file\);/.test(update),'the verified file stays pinned until the installer ran');
ok(/WinVerifyTrust\(new IntPtr\(-1\), ref action, ref data\)/.test(update)&&/fdwRevocationChecks = 1/.test(update),'WinVerifyTrust with revocation checks');
ok(/dwProvFlags = 0x80 \| 0x2000/.test(update),'the revocation check of the chain without the root, no MD2/MD4');
// Each signature on the pinned handle; the signer from the same verified state.
ok(!/CreateFromSignedFile/.test(update),'the signer is not read from the file again (CreateFromSignedFile)');
ok(/WssVerifySpecific = 0x1, WssGetSecondarySigCount = 0x2/.test(update)&&/dwFlags = WssVerifySpecific \| \(index == 0 \? WssGetSecondarySigCount : 0\)/.test(update)&&/data\.pSignatureSettings = settings/.test(update),'the primary signature reports the nested count; each signature is verified by index');
ok(/for \(uint index = 0; index <= secondary && index < MaximumSignatures; index\+\+\)/.test(update),'the primary and every nested signature are checked, at most 16');
ok(/WTHelperProvDataFromStateData\(state\)/.test(update)&&/WTHelperGetProvSignerFromChain\(provider, 0, false, 0\)/.test(update)&&/WTHelperGetProvCertFromChain\(signerPointer, 0\)/.test(update),'the signer certificate comes from the state of the verify call');
const verify=update.slice(update.indexOf('private static (int Result, string? Organization, string? DigestOid, uint Secondary) Verify'),update.indexOf('private static (string? Organization, string? DigestOid) Signer'));
ok(verify.indexOf('Signer(data.hWVTStateData)')>0&&verify.indexOf('Signer(data.hWVTStateData)')<verify.indexOf('finally'),'the signer is read before the state is closed');
ok(/finally\s*\{[^{}]*if \(opened\) \{ data\.dwStateAction = StateActionClose; WinVerifyTrust\(new IntPtr\(-1\), ref action, ref data\); \}/.test(verify)&&/StateActionVerify = 1, StateActionClose = 2/.test(update),'every opened state is closed in finally');
ok(/try \{ return SignatureAccepted\(vendor, Signatures\(path, handle\)\); \}/.test(update),'the pure decision function decides');
ok(/StrongDigests = \["2\.16\.840\.1\.101\.3\.4\.2\.1", "2\.16\.840\.1\.101\.3\.4\.2\.2", "2\.16\.840\.1\.101\.3\.4\.2\.3"\]/.test(update),'SHA-256, SHA-384 and SHA-512 only');
ok(/\["nvidia"\] = \["NVIDIA Corporation"\],\s*\["amd"\] = \["Advanced Micro Devices, Inc\.", "Advanced Micro Devices Inc\."\],/.test(update),'the pinned signer organizations');
ok(/"2\.5\.4\.10"/.test(update)&&/StringComparer\.Ordinal\)\s*;?/.test(update),'the subject organization (O=) is compared exactly');
ok(update.indexOf('SignedBy(job.Vendor')<update.indexOf('RunInstallerAsync(job, file'),'the signature check comes before the installer');
ok(/throw new AgentMessageException\("AGENT_GPU_DRIVER_SIGNATURE"/.test(update),'a wrong signature fails before anything runs');

// ---- The installer: the verified file itself, fixed arguments, no shell ----
const installer=update.slice(update.indexOf('private static async Task<int> RunInstallerAsync'),update.indexOf('private static bool SignedBy'));
ok(/new ProcessStartInfo\(file\) \{ UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = folder \}/.test(installer),'UseShellExecute = false on the staged file');
ok(!/cmd\.exe|powershell|pwsh|\/c /i.test(installer)&&!/cmd\.exe|powershell\.exe|pwsh/i.test(update),'no cmd.exe and no PowerShell in the installer path');
ok(/foreach \(string argument in Arguments\[job\.Vendor\]\) start\.ArgumentList\.Add\(argument\);/.test(installer)&&!/Arguments\s*=/.test(installer),'only the fixed argument lists, through ArgumentList');
ok(/\["nvidia"\] = \["-s", "-noreboot"\],\s*\["amd"\] = \["-INSTALL"\],/.test(update),'NVIDIA -s -noreboot, AMD -INSTALL');
ok(/limit\.CancelAfter\(InstallLimit\)/.test(installer)&&/process\.Kill\(entireProcessTree: true\)/.test(installer)&&/"AGENT_GPU_DRIVER_TIMEOUT"/.test(installer),'30 minutes, then the process tree is killed');
ok(!/Restart|shutdown|InitiateSystemShutdown/i.test(update.replace(/RebootExitCodes|INSTALLED_REBOOT|NativeRebootStatus\.Read\(\)\.Pending|"Restart the device|RestartManager/g,'')),'the agent never restarts the device');

// ---- Cleanup after every outcome ----
const install=update.slice(update.indexOf('internal static async Task<AgentMessage> InstallAsync'),update.indexOf('private static async Task<int> RunInstallerAsync'));
ok(/finally\s*\{\s*if \(folder is not null\) try \{ StagingFiles\.DeleteFolder\(folder, true/.test(install),'the staged files are deleted in finally');
const registry=relay.slice(relay.indexOf('internal sealed class GpuDriverDownloads'));
const method=name=>registry.slice(registry.indexOf(name),registry.indexOf('\n    }\n',registry.indexOf(name)));
ok(/finally \{ try \{ await relay\.CallAsync\(new JsonObject \{ \["kind"\] = "gpu-driver-close"/.test(relay)&&/case "gpu-driver-close":\s*\{\s*gpuDrivers\.Close\(GpuDriverHandle\(request\)\);/.test(relay)&&/download\.Cancel\(\); try \{ File\.Delete\(download\.Path\); \} catch \{ \}\s*download\.Dispose\(\);/.test(method('internal bool Close(')),'the .part file goes on close, also while the download runs; the close disposes after it removed the entry');
ok(/catch \{ gpuDrivers\.Fail\(handle, download\); throw; \}/.test(relay)&&/downloads\.TryRemove\(new KeyValuePair<string, Download>\(handle, download\)\)/.test(method('internal void Fail(')),'a failed download removes only its own entry and deletes its .part file');
// The stale purge cancels, removes and deletes, but never disposes (4.17.1).
const purge=method('internal void PurgeStale(');
ok(purge.includes('downloads.TryRemove(stale)')&&purge.includes('File.Delete(stale.Value.Path)')&&!/Dispose\(/.test(purge),'the stale purge has no Dispose');
ok(!/Stop\.Dispose\(\)/.test(relay)&&/Token = stop\.Token;/.test(registry)&&/try \{ stop\.Cancel\(\); \} catch \(ObjectDisposedException\) \{ \}/.test(registry),'a download keeps its token from the start; a late cancel ignores a disposed source');
// A read of a removed, cancelled or missing part gets the clean error.
ok(/internal const string UnknownMessage = "Unknown GPU driver download\.";/.test(registry)&&/catch \(Exception e\) when \(e is FileNotFoundException or DirectoryNotFoundException\) \{ throw Unknown\(\); \}/.test(method('internal FileStream OpenPart('))&&/var download = gpuDrivers\.Get\(handle\);/.test(relay)&&/await using var file = gpuDrivers\.OpenPart\(handle, download\);/.test(relay),'gpu-driver-read maps a missing part to "Unknown GPU driver download."');
ok(/GpuDriverUpdate\.CleanStaging\(root\);/.test(runner)&&/Directory\.GetFiles\(downloadRoot, "\*\.part"\)/.test(relay),'a restart removes staged and .part files');
ok(/or "install-gpu-driver"\) &&/.test(runner),'success and failure ask for an inventory refresh');

// ---- Capability, mode and validation ----
const actions=/ManagementActions = \[([^\]]+)\]/.exec(runner)[1],reads=/ReadActions = \[([^\]]+)\]/.exec(runner)[1];
ok(actions.includes('"install-gpu-driver"')&&!reads.includes('install-gpu-driver'),'the capability is a management action and not a read');
ok(/case "install-gpu-driver": GpuDriverUpdate\.Validate\(p\); return;/.test(management),'NativeManagement.ValidateParameters checks the job');
ok(/else if \(action == "install-gpu-driver"\) message = await GpuDriverUpdate\.InstallAsync\(root, p, gpuDrivers, token\);/.test(management),'the install runs after AssertManagement in NativeManagement');
ok(/"AGENT_GPU_DRIVER_NO_GPU"/.test(update)&&/"AGENT_BUSY"/.test(update)&&/"AGENT_GPU_DRIVER_DISK_SPACE", \("size"/.test(update),'no GPU, busy and disk space are refused');
ok(/RadeonSoftwareVersion/.test(update)&&/"VEN_1002&DEV_"/.test(update)&&/GpuDriverUpdate\.AmdSoftwareVersion/.test(details),'the AMD version comes from the display class key');

// ---- NVML follows a driver update (4.17.2): a new DXCore driver version reloads NVML ----
const nvml=code('agent/v3/NvidiaGpuSensors.cs');
const reload=nvml.slice(nvml.indexOf('private void ReloadOnDriverChange('),nvml.indexOf('private void Remember('));
ok(/private readonly Dictionary<string, ulong\?> driverVersions/.test(nvml)&&/driverVersions\.TryAdd\(key, adapter\.Hardware!\.DriverVersion\)/.test(nvml)&&/else driverVersions\.Clear\(\);/.test(nvml),'the DXCore driver version of each adapter is remembered from the NVML initialization on');
ok(/known == adapter\.Hardware!\.DriverVersion\) return;/.test(reload)&&/Function<InitializeFunction>\("nvmlShutdown"\)/.test(reload)&&/initialized = false;/.test(reload)&&/if \(!injected\) \{ library\?\.Dispose\(\); library = null; \}/.test(reload),'a changed driver version shuts NVML down and frees a library it loaded itself');
const readMethod=nvml.slice(nvml.indexOf('public JsonObject? Read('));
ok(readMethod.indexOf('ReloadOnDriverChange(adapter);')>0&&readMethod.indexOf('ReloadOnDriverChange(adapter);')<readMethod.indexOf('if (!Initialize()) return null;')&&readMethod.indexOf('if (!Initialize()) return null;')<readMethod.indexOf('"vendorDriverVersion"'),'Read compares the driver version and initializes NVML again before it reads vendorDriverVersion');
ok(/retryAt = DateTimeOffset\.UtcNow\.AddMinutes\(1\)/.test(nvml),'a failed initialization waits 1 minute');
ok(/NvmlDriverChange\(adapter,gpus,at\);/.test(read('agent/v3/NativeGpuDetailsTests.cs')),'the GPU details self-test covers the reload');

// ---- Release ----
ok(/internal const string BaseVersion = "4\.(1[3-9]|[2-9]\d)\.\d+";/.test(program),'agent 4.13.0 or later');
ok(/args\[0\] == "--gpu-driver-self-test"\) return await GpuDriverUpdateTests\.RunSelfTestAsync\(\);/.test(program),'the self-test is registered in Program.cs');
ok(build.includes("'--gpu-driver-self-test'"),'the release build runs the self-test');
ok(readme.includes('--gpu-driver-self-test'),'the README lists the self-test');

console.log(`PASS: ${checks} static checks of the agent GPU driver update.`);
