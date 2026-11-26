import { z } from 'zod';
import { extensionTargetIds, pluginCapabilityPattern, pluginExePath, pluginLimits, pluginNamePattern } from './plugin-release-verify.mjs';
import { baseVersionPattern, releaseVersionPattern } from './release-version.mjs';

// The schema of a signed agent release manifest, shared by the catalog
// (lib/server/agent/releases.ts, verifiedRelease) and the import (runtime/release-import.mjs),
// so the import never stores a manifest that the catalog would refuse.
// The schema still parses the older absolute form (a file named by its URL) so
// that the catalog can refuse it with its own error; the portal accepts only
// the path form (runtime/release-manifest.mjs holds the form and path rules).
const releaseFile = { url: z.string().url().optional(), path: z.string().max(256).optional() };
const releasePart = z.object({ ...releaseFile, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(20971520) }).strict();
export const changelogSchema = z.object({ features: z.array(z.string().trim().min(1).max(200)).max(10), fixes: z.array(z.string().trim().min(1).max(200)).max(10) }).strict().refine(notes => notes.features.length + notes.fixes.length > 0);
export const manifestSchema = z.object({
  // X.Y.Z or a dev build X.Y.Z-dev.<sha7> (runtime/release-version.mjs).
  version: z.string().regex(releaseVersionPattern), protocolVersion: z.literal(3), minProtocolVersion: z.number().int().min(3).max(3), os: z.array(z.string()).min(1).max(4), arch: z.literal('x64'),
  ...releaseFile, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(104857600), parts: z.array(releasePart).min(1).max(6).optional(), layout: z.literal('single-exe').optional(),
  exe: z.object({ ...releaseFile, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(250000000), parts: z.array(releasePart).min(1).max(12).optional() }).strict().optional(),
  changelog: changelogSchema.optional(), createdAt: z.string().datetime(),
}).strict();

// The plugin constants live in runtime/plugin-release-verify.mjs, which the CLI
// runs without a package install; the schema of the portal uses the same values.
export { extensionTargetIds, pluginCapabilityPattern, pluginExePath, pluginLimits, pluginNamePattern };
const pluginPart = z.object({ path: z.string().max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(pluginLimits.part) }).strict();
/**
 * The signed manifest of a plugin release (docs/agent-plugins.md). Only the path
 * form: the EXE and its parts are paths below /downloads/ without an origin, so
 * one publisher signature is valid on every installation. target is optional
 * (older manifests have only role); with target, role must equal it, because
 * deployed agents require role.
 */
export const pluginManifestSchema = z.object({
  kind: z.literal('plugin'), name: z.string().regex(pluginNamePattern), role: z.enum(extensionTargetIds), target: z.enum(extensionTargetIds).optional(),
  version: z.string().regex(releaseVersionPattern), minAgentVersion: z.string().regex(baseVersionPattern), protocolVersion: z.literal(1),
  os: z.array(z.string().min(1).max(64)).min(1).max(4), arch: z.literal('x64'),
  capabilities: z.array(z.string().regex(pluginCapabilityPattern)).min(1).max(32).refine(list => new Set(list).size === list.length, 'Capabilities must be unique.'),
  exe: z.object({ path: z.string().max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(pluginLimits.exe), parts: z.array(pluginPart).min(1).max(pluginLimits.parts).optional() }).strict(),
  changelog: changelogSchema, createdAt: z.string().datetime(),
}).strict().superRefine((manifest, context) => {
  if (manifest.target !== undefined && manifest.role !== manifest.target) context.addIssue({ code: 'custom', path: ['role'], message: 'The plugin role must equal the plugin target.' });
  const expected = pluginExePath(manifest.name, manifest.version);
  if (manifest.exe.path !== expected) context.addIssue({ code: 'custom', path: ['exe', 'path'], message: `The plugin EXE must have the path ${expected}.` });
  const parts = manifest.exe.parts;
  if (parts) {
    if (parts.reduce((total, part) => total + part.size, 0) !== manifest.exe.size) context.addIssue({ code: 'custom', path: ['exe', 'parts'], message: 'The part sizes must add up to the EXE size.' });
    parts.forEach((part, index) => { if (part.path !== `${expected}.part${index + 1}`) context.addIssue({ code: 'custom', path: ['exe', 'parts', index, 'path'], message: `Part ${index + 1} must have the path ${expected}.part${index + 1}.` }); });
  }
});
