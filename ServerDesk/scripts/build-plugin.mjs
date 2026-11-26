import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pluginCapabilityPattern, pluginExePath, pluginLimits, pluginReleasePartSize, extensionTargetIds } from '../runtime/plugin-release-verify.mjs';
import { pluginPaths } from './plugin-release.mjs';
import { buildVersion, isBaseVersion } from '../runtime/release-version.mjs';

// Builds one agent plugin (docs/agent-plugins.md): dotnet publish of
// agent/plugins/<name> as a self-contained single-file x64 EXE, then --version
// and --self-test on the published EXE, then .build/plugin-<name>-artifact.json
// with the plugin metadata from the project file and the SHA-256 of the EXE.
//   node scripts/build-plugin.mjs --plugin dhcp
// The plugin metadata are MSBuild properties of the project file: <Version>,
// <PluginTarget> (a detection id of lib/extensions.ts; the older <PluginRole>
// counts when <PluginTarget> is absent), <PluginMinAgentVersion> and
// <PluginCapabilities> (separated by ;).
// The Plugin release workflow passes the version of its plan in
// SERVERDESK_PLUGIN_VERSION: <Version>, or on dev <Version>-dev.<sha7>. dotnet
// publish gets the suffix (ServerDeskDevSuffix, agent/BuildVersion.targets), so
// --version, the plugin hello and the artifact carry the full version.

const root = fileURLToPath(new URL('..', import.meta.url));
const sdk = process.env.SERVERDESK_DOTNET ?? 'dotnet';
const operatingSystems = ['Windows Server 2022', 'Windows Server 2025'];

/** The plugin metadata of a project file. Throws for a missing or invalid property. */
export function pluginProjectMetadata(csproj, name) {
  const property = key => new RegExp(`<${key}>([^<]*)</${key}>`).exec(csproj)?.[1]?.trim();
  const version = property('Version'), target = property('PluginTarget') || property('PluginRole'), minAgentVersion = property('PluginMinAgentVersion');
  const capabilities = (property('PluginCapabilities') ?? '').split(';').map(entry => entry.trim()).filter(Boolean);
  if (!isBaseVersion(version)) throw new Error(`The plugin ${name} needs <Version>X.Y.Z</Version>.`);
  if (!target || !extensionTargetIds.includes(target)) throw new Error(`The plugin ${name} needs <PluginTarget> with an id of the detection catalog.`);
  if (!isBaseVersion(minAgentVersion)) throw new Error(`The plugin ${name} needs <PluginMinAgentVersion>X.Y.Z</PluginMinAgentVersion>.`);
  if (!capabilities.length || capabilities.length > 32 || capabilities.some(entry => !pluginCapabilityPattern.test(entry)) || new Set(capabilities).size !== capabilities.length) throw new Error(`The plugin ${name} needs 1 to 32 unique <PluginCapabilities>.`);
  return { name, version, target, minAgentVersion, capabilities, os: operatingSystems, arch: 'x64' };
}

function build(name, env) {
  const paths = pluginPaths(name), project = path.join(root, paths.project);
  const metadata = pluginProjectMetadata(fs.readFileSync(project, 'utf8'), name);
  const { version, devSuffix } = buildVersion(metadata.version, env.SERVERDESK_PLUGIN_VERSION);
  metadata.version = version;
  const output = path.join(root, paths.publish), executable = path.join(output, paths.exe);
  const run = (command, args) => { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' }); if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`); };
  fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output, { recursive: true });
  run(sdk, ['publish', paths.project, '-c', 'Release', '-r', 'win-x64', `-p:ServerDeskDevSuffix=${devSuffix}`, '-o', output]);
  // The release is one self-contained executable, like the agent.
  const entries = fs.readdirSync(output, { withFileTypes: true });
  const extra = entries.filter(entry => !entry.isFile() || (entry.name !== paths.exe && !entry.name.endsWith('.pdb'))).map(entry => entry.name);
  if (extra.length || !fs.existsSync(executable)) throw new Error(`Single-file publish left other files: ${extra.join(', ')}. Bundle these before packaging.`);
  for (const entry of entries) if (entry.name.endsWith('.pdb')) fs.unlinkSync(path.join(output, entry.name));
  const bytes = fs.readFileSync(executable);
  if (bytes.length > pluginLimits.exe) throw new Error(`The plugin EXE has ${bytes.length} bytes; at most ${pluginLimits.exe} are allowed.`);
  if (process.platform === 'win32') {
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });
    if (version.error) throw new Error(`Plugin execution check failed: ${version.error.code}. The packaged EXE was not validated by execution.`);
    if (version.status !== 0 || version.stdout.trim() !== metadata.version) throw new Error(`The plugin EXE reports version "${version.stdout.trim()}", not ${metadata.version}.`);
    run(executable, ['--self-test']);
    console.log(`Plugin ${name} ${metadata.version}: version and self-test verified on the packaged EXE.`);
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const parts = [];
  if (bytes.length > pluginReleasePartSize) {
    for (let offset = 0, index = 1; offset < bytes.length; offset += pluginReleasePartSize, index++) {
      const slice = bytes.subarray(offset, Math.min(offset + pluginReleasePartSize, bytes.length));
      parts.push({ path: `${pluginExePath(name, metadata.version)}.part${index}`, sha256: crypto.createHash('sha256').update(slice).digest('hex'), size: slice.length });
    }
  }
  const artifact = { ...metadata, exe: { path: pluginExePath(name, metadata.version), sha256, size: bytes.length, ...(parts.length ? { parts } : {}) } };
  fs.writeFileSync(path.join(root, paths.artifact), JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify(artifact));
}

const direct = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { plugin: { type: 'string' } } });
    if (!values.plugin) throw new Error('Usage: node scripts/build-plugin.mjs --plugin <name>');
    build(values.plugin, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
