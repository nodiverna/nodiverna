import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { agentReleasePartEntries as partEntries } from '../runtime/agent-release-verify.mjs';
import { buildVersion } from '../runtime/release-version.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const sdk=process.env.SERVERDESK_DOTNET??'dotnet';
const smokeMode=process.env.SERVERDESK_AGENT_SMOKE_MODE??'native';
if(!['native','managed'].includes(smokeMode))throw new Error('SERVERDESK_AGENT_SMOKE_MODE must be native or managed.');
const projectVersion=fs.readFileSync(path.join(root,'agent/v3/ServerDesk.Agent.csproj'),'utf8').match(/<Version>(\d+\.\d+\.\d+(?:\.\d+)?)<\/Version>/)?.[1];
if(!projectVersion)throw new Error('Native agent version missing.');
// The Agent release workflow passes the version of its plan: the csproj
// <Version>, or on dev that version plus -dev.<sha7>. dotnet publish gets the
// suffix (ServerDeskDevSuffix, agent/BuildVersion.targets), so Program.Version
// and --version carry the full version. Without the variable a local build
// keeps the csproj version.
const {version,devSuffix}=buildVersion(projectVersion,process.env.SERVERDESK_AGENT_VERSION);
// Signed manifests and queued updates pin the bytes behind a version's paths.
// A version with the tag agent-vX.Y.Z is published: refuse before touching any
// file. Re-signing an existing artifact needs no rebuild.
const tags=spawnSync('git',['tag','--list',`agent-v${version}`],{cwd:root,encoding:'utf8'});
if(tags.error||tags.status!==0)throw new Error(`git tag --list failed: ${(tags.stderr||tags.error?.message||'').trim()}. The build checks the agent-v* tags in a Git checkout.`);
if(tags.stdout.split(/\r?\n/).some(line=>line.trim()===`agent-v${version}`))throw new Error(`Agent ${version} is already published as agent-v${version}. Increase <Version> in agent/v3/ServerDesk.Agent.csproj before building.`);
// The build writes only to .build/: the ZIP, the publish output and the
// metadata. Portals serve the files of imported releases; nothing goes to public/.
const output=path.join(root,'.build','agent-v3-publish');
const run=(cmd,args)=>{const result=spawnSync(cmd,args,{cwd:root,stdio:'inherit'});if(result.status!==0)throw new Error(`${cmd} failed (${result.status}).`);};
fs.rmSync(output,{recursive:true,force:true});fs.mkdirSync(output,{recursive:true});
run(sdk,['publish','agent/v3/ServerDesk.Agent.csproj','-c','Release','-r','win-x64','-p:PublishTrimmed=false',`-p:ServerDeskDevSuffix=${devSuffix}`,'-o',output]);
// The deployed release is one self-contained executable. Fail rather than
// silently dropping a dependency that the published application still needs.
const published=fs.readdirSync(output,{withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>entry.name);
const extra=published.filter(name=>name!=='ServerDesk.Agent.exe'&&!name.endsWith('.pdb'));
if(extra.length||!published.includes('ServerDesk.Agent.exe')||fs.readdirSync(output,{withFileTypes:true}).some(entry=>entry.isDirectory()))throw new Error(`Single-file publish left external dependencies: ${extra.join(', ')}. Bundle these before packaging.`);
for(const name of published)if(name.endsWith('.pdb'))fs.unlinkSync(path.join(output,name));
if(process.platform==='win32'){
 const executable=path.join(output,'ServerDesk.Agent.exe');
 // Development hosts with application control can test the published managed
 // assembly through the installed SDK. This does not change OS policy or run
 // the packaged EXE; native EXE execution remains the default smoke path.
 const managedAssembly=path.join(root,'agent/v3/bin/Release/net10.0/win-x64/ServerDesk.Agent.dll');
 const command=smokeMode==='managed'?sdk:executable,prefix=smokeMode==='managed'?[managedAssembly]:[];
 if(smokeMode==='managed'&&!fs.existsSync(managedAssembly))throw new Error('Published managed assembly missing.');
 const actual=spawnSync(command,[...prefix,'--version'],{encoding:'utf8'});
 if(actual.error)throw new Error(`Agent execution check failed: ${actual.error.code}. The packaged EXE was not validated by execution.`);
 if(actual.status!==0||actual.stdout.trim()!==version)throw new Error('Compiled native agent version differs from its release metadata.');
 for(const test of ['--broker-self-test','--installer-self-test','--features-self-test','--health-self-test','--gpu-self-test','--gpu-details-self-test','--hardware-self-test','--crash-self-test','--software-self-test','--bitlocker-self-test','--drivers-self-test','--reliability-self-test','--disk-health-self-test','--certificates-self-test','--autostart-self-test','--defender-self-test','--defender-control-self-test','--failure-paths-self-test','--gpu-driver-self-test','--jobs-self-test','--plugin-self-test','--integrity-self-test'])run(command,[...prefix,test]);
 // The service lifecycle self-test installs, kills, stops and removes two test
 // services with the real setup code. Exit 2: not elevated, skipped; that fails
 // the build only with SERVERDESK_AGENT_LIFECYCLE_TEST=required (the Agent release workflow).
 const lifecycle=spawnSync(command,[...prefix,'--service-lifecycle-self-test'],{cwd:root,stdio:'inherit'});
 if(lifecycle.status===2){if(process.env.SERVERDESK_AGENT_LIFECYCLE_TEST==='required')throw new Error('The service lifecycle self-test needs elevation (SERVERDESK_AGENT_LIFECYCLE_TEST=required).');console.warn('The service lifecycle self-test was skipped: it needs an elevated terminal.');}
 else if(lifecycle.status!==0)throw new Error('Service lifecycle self-test failed ('+lifecycle.status+').');
 console.log(`Agent version + self-tests verified with ${smokeMode==='managed'?'installed SDK / published managed assembly':'packaged native EXE'}.`);
}
const base=`ServerDesk-Agent-${version}-win-x64.zip`;
const zip=path.join(root,'.build',base);
if(fs.existsSync(zip))fs.unlinkSync(zip);
fs.writeFileSync(zip,zipSync({'ServerDesk.Agent.exe':new Uint8Array(fs.readFileSync(path.join(output,'ServerDesk.Agent.exe')))}, {level:9}));
const bytes=fs.readFileSync(zip);if(bytes.length>100*1024*1024)throw new Error('Release exceeds the installed v3 updater 100 MiB migration limit. Use an explicitly compatible migration release.');
const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
// A file above 20 MiB is described by its consecutive 20 MiB slices. The parts
// are only manifest entries: the portal serves each slice from the whole file.
const parts=partEntries(bytes,base);
const exePath=path.join(output,'ServerDesk.Agent.exe'),exeBase=`ServerDesk-Agent-${version}-win-x64.exe`,exeBytes=fs.readFileSync(exePath);
const exe={path:'/downloads/'+exeBase,size:exeBytes.length,sha256:crypto.createHash('sha256').update(exeBytes).digest('hex'),parts:partEntries(exeBytes,exeBase)};
const metadata={version,arch:'x64',protocolVersion:3,size:bytes.length,sha256,path:'/downloads/'+base,parts,layout:'single-exe',exe};
fs.writeFileSync(path.join(root,'.build','agent-v3-artifact.json'),JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify(metadata));
