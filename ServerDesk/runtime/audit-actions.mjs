// The audit actions that the runtime and the self-host script write (runtime/maintenance.mjs,
// runtime/release-import.mjs, scripts/selfhost.mjs). No imports, so the console's display map
// (ui/devices/history/audit-display.ts) can import them on the client and a changed text cannot drift from it.
export const maintenanceRunAuditAction = 'Maintenance run started';
export const auditRetentionAuditAction = 'Audit retention applied';
export const releaseImportAuditActions = Object.freeze({ github: 'Agent release imported from GitHub', folder: 'Agent release imported from a folder' });
export const pluginImportAuditActions = Object.freeze({ github: 'Plugin release imported from GitHub', folder: 'Plugin release imported from a folder' });
export const secretsRewrapAuditAction = 'Secrets rewrapped';
export const totpResetAuditAction = 'TOTP authenticators reset';
