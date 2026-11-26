// Static checks of the agent sources of the health signals: the BitLocker
// collector calls no method that returns or stores a secret, the software
// collector reads no path value, osInfo reads the listed registry values, the
// new privileged collectors are fixed broker reads and the self-tests are
// registered. No database, no build.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
const bitlocker=read('agent/v3/NativeBitLocker.cs'),software=read('agent/v3/NativeSoftwareInventory.cs'),telemetry=read('agent/v3/NativeTelemetry.cs'),broker=read('agent/v3/AgentBroker.cs'),crash=read('agent/v3/NativeCrashInventory.cs'),program=read('agent/v3/Program.cs'),build=read('scripts/build-agent-v3.mjs');

for(const method of ['GetKeyProtectorNumericalPassword','GetKeyProtectorExternalKey','GetExternalKeyFromFile','BackupRecoveryInformationToActiveDirectory','BackupRecoveryInformationToCloudDomain','GetKeyPackage','GetKeyProtectorCertificate','GetKeyProtectorPlatformValidationProfile','GetKeyProtectorFriendlyName','ProtectKeyWith','UnlockWith','Decrypt','Encrypt','DisableKeyProtectors','EnableKeyProtectors','DeleteKeyProtector'])
 ok(!new RegExp(String.raw`\b${method}\b`).test(bitlocker),`the BitLocker source never names ${method}`);
ok(/ReadMethods = \["GetConversionStatus", "GetProtectionStatus", "GetEncryptionMethod", "GetKeyProtectors", "GetKeyProtectorType"\]/.test(bitlocker),'the BitLocker provider lists exactly the read methods');
ok(/if \(!ReadMethods\.Contains\(method, StringComparer\.Ordinal\)\) throw/.test(bitlocker),'and refuses any other method');
for(const value of ['InstallLocation','UninstallString','QuietUninstallString','DisplayIcon','InstallSource','ModifyPath','LocalPackage','InstallPath'])
 ok(!software.includes(value),`the software source never reads ${value}`);
ok(/ValueNames = \["DisplayName", "DisplayVersion", "Publisher", "InstallDate", "SystemComponent", "ParentKeyName", "ReleaseType"\]/.test(software),'the software source reads only the display values');
ok(!/LoadKey|RegLoadKey|RegLoadAppKey/.test(software),'the software source never loads a hive');
for(const value of ['EditionID','InstallationType','DisplayVersion','ReleaseId','UBR','ProductName','CurrentBuild'])ok(telemetry.includes(`"${value}"`),`osInfo reads ${value}`);
ok(/SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion/.test(telemetry),'osInfo reads the CurrentVersion key');
ok(/PrivilegedProviders = \[[^\]]*"Crashes", "BitLocker", "Software inventory"[,\]]/.test(telemetry),'the three collectors are privileged providers');
for(const name of ['Crashes','BitLocker','Software inventory'])ok(broker.includes(`"${name}" =>`),`the broker switch reads ${name}`);
ok(/Add\("Crashes", NativeCrashInventory\.IntervalSeconds/.test(telemetry)&&/IntervalSeconds = 900/.test(crash),'crashes every 900 s');
ok(/Add\("BitLocker", NativeBitLocker\.IntervalSeconds/.test(telemetry)&&/IntervalSeconds = 300/.test(bitlocker),'BitLocker every 300 s');
ok(/Add\("Software inventory", NativeSoftwareInventory\.IntervalSeconds/.test(telemetry)&&/IntervalSeconds = 900/.test(software),'software every 900 s');
ok(/MaximumBytes = 32L \* 1024 \* 1024/.test(crash)&&/MaximumDrivers = 4096/.test(crash)&&/MaximumNameChars = 260/.test(crash)&&/MaximumParsedDumps = 20/.test(crash),'the minidump caps');
ok(/RecurseSubdirectories = false/.test(crash)&&/ReparsePoint/.test(crash),'the minidump folder without recursion or reparse points');
// Agent 4.13.1: the dump is opened once, through a handle that never follows a reparse point and is checked before any read.
const openDump=crash.slice(crash.indexOf('internal static SafeFileHandle OpenDumpFile('),crash.indexOf('catch { handle.Dispose(); throw; }'));
const readBounded=crash.slice(crash.indexOf('internal static byte[] ReadBounded('),crash.indexOf('private const uint GenericRead'));
ok(openDump.length>0&&/OpenReparsePoint \| SequentialScan/.test(openDump)&&/OpenReparsePoint = 0x00200000/.test(crash),'the dump open path uses FILE_FLAG_OPEN_REPARSE_POINT');
ok(/ShareRead \| ShareWrite \| ShareDelete/.test(openDump)&&/GenericRead/.test(openDump)&&/OpenExisting/.test(openDump),'the dump opens for reading only, with read, write and delete sharing');
ok(!crash.includes('new FileStream(path, FileMode.Open'),'no dump is opened by path with a plain FileStream');
ok(/GetFileInformationByHandleEx\(handle, FileAttributeTagInfo/.test(openDump)&&/GetFileType\(handle\) != FileTypeDisk/.test(openDump),'the opened handle is checked for its attributes and its file type');
ok(/FileAttributes\.ReparsePoint \| FileAttributes\.Directory \| FileAttributes\.Device \| FileAttributes\.Offline/.test(crash),'a link, folder, device or offline file is refused');
ok(/using var handle = OpenDumpFile\(path\)/.test(readBounded)&&/RandomAccess\.GetLength\(handle\)/.test(readBounded)&&/new FileStream\(handle, FileAccess\.Read/.test(readBounded),'the size cap and the read use the checked handle');
ok((crash.match(/CreateFileW\(/g)??[]).length===2,'CreateFileW is declared and called once, in OpenDumpFile');
ok(/PlainDriverName\(string name\)[^;]*ReservedDeviceNames\.Contains\(name\.Split\('\.'\)\[0\]\.TrimEnd\(' '\)\)/.test(crash)&&/"CON", "PRN", "AUX", "NUL", "CONIN\$", "CONOUT\$", "CLOCK\$"/.test(crash),'PlainDriverName refuses the reserved device names');
for(const test of ['--crash-self-test','--software-self-test','--bitlocker-self-test']){ok(program.includes(`"${test}"`),`Program.cs runs ${test}`);ok(build.includes(`'${test}'`),`the build runs ${test}`);}
ok(/!pair\.Key\.StartsWith\('_'\)/.test(telemetry),'the software list never enters the snapshot');
console.log(`PASS agent health signal sources (${checks} checks): no BitLocker secret methods, no software path values, osInfo registry values, privileged broker reads, caps and registered self-tests.`);
