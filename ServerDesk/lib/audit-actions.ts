// Audit action texts that the API routes write with log() (lib/server/context.ts), and the
// action constants of the other writers. The audit table stores them as they were
// written; the console maps each one to a code and a catalog label
// (ui/devices/history/audit-display.ts), which imports these constants, so a changed text cannot
// drift from the map. Pure: no imports, so the client can import it.
export const routeAuditActions={
 agentCreated:'Agent erstellt',
 agentUpdateScheduled:'Agentupdate geplant',
 jobCancelled:'Auftrag abgebrochen',
 transferCancelled:'Dateitransfer abgebrochen',
 rdpClosed:'Remote Desktop getrennt',
 rdpOpened:'Remote Desktop geöffnet',
 releaseImported:'Signiertes Agentrelease importiert',
 releaseDeleted:'Agentrelease gelöscht',
 releaseDisabled:'Agentrelease deaktiviert',
} as const;

export const pluginAuditActions={installQueued:'Plugin install queued',removalQueued:'Plugin removal queued',rolloutPlanned:'Plugin rollout planned',rolloutAcrossCustomers:'Plugin rollout across customers planned'} as const;
/** The AD sign-in of plugin changes (lib/server/extensions/plugin-ad-sessions.ts). */
export const adAuditActions={signIn:'AD sign-in',failed:'AD sign-in failed',signOut:'AD sign-out'} as const;
export const releaseSourceAuditActions={checkRequested:'Agent release check requested',devBuildsOn:'Agent dev builds turned on',devBuildsOff:'Agent dev builds turned off'} as const;
/**
 * Display only: the release source had a GitHub token until the repository
 * became public. Old audit rows keep these actions; ui/devices/history/audit-display.ts
 * still labels them. No writer imports this constant.
 */
export const retiredReleaseSourceAuditActions={tokenSet:'GitHub token for agent releases saved',tokenRemoved:'GitHub token for agent releases removed'} as const;
export const maintenanceAuditAction='Maintenance settings changed';
export const sessionIdleTimeoutAuditAction='Automatische Abmeldung geändert';
export const sessionIdleRequiresMfaAuditAction='MFA nach automatischer Abmeldung geändert';
export const vulnerabilityAuditActions={on:'Vulnerability check turned on',off:'Vulnerability check turned off',keySet:'NVD API key saved',keyRemoved:'NVD API key removed',secondSourceOn:'CVE.org source turned on',secondSourceOff:'CVE.org source turned off'} as const;
export const assistantAuditActions={
 organizationSet:'assistant.organization-key.set',organizationRemoved:'assistant.organization-key.removed',
 personalSet:'assistant.personal-key.set',personalRemoved:'assistant.personal-key.removed',
 customerSet:'assistant.customer-key.set',customerRemoved:'assistant.customer-key.removed',
} as const;
/** The usage data switch (lib/server/usage-data.ts). */
export const usageDataAuditActions={enabled:'Datensammlung eingeschaltet',disabled:'Datensammlung ausgeschaltet'} as const;
/** The setting "Multiple customers" (lib/server/identity/multiple-customers.ts); the target stays empty. */
export const multipleCustomersAuditActions={enable:'customers.multiple.enable',disable:'customers.multiple.disable'} as const;
/**
 * Branding (lib/server/branding.ts). Images: the target is the slot (light, dark, icon, signin or console), a customer
 * logo also sets the row's customer. backgroundSet: the target is the area (signin or console). schemeSet and
 * schemeRemove: the target is "scheme".
 */
export const brandingAuditActions={portalSet:'branding.portal.set',portalRemove:'branding.portal.remove',customerSet:'branding.customer.set',customerRemove:'branding.customer.remove',
 backgroundSet:'branding.background.set',schemeSet:'branding.scheme.set',schemeRemove:'branding.scheme.remove'} as const;
/** The Owner's default Dashboard layout (lib/server/dashboard-data.ts); the target is "layout". */
export const dashboardAuditActions={defaultSet:'dashboard.default.set',defaultRemove:'dashboard.default.remove'} as const;
export const roleSyncAuditAction='auth.entra.roles.sync';
export const dhcpReplicateAuditAction='Replicate DHCP failover';
export const dhcpCrossCustomerAuditAction='DHCP change across customers';
/** Deleting a customer (lib/server/identity/customer-admin.ts deleteCustomer); the target is the customer name, the row has no customer. */
export const customerAuditActions={delete:'customer.delete'} as const;
/**
 * Moving devices to another customer (lib/server/devices/device-customer-move.ts): per device one portal row in the
 * source customer (target "{name} / {id} → {target customer}") and one device row in the target customer (target
 * "{name} / {id} ← {source customer}").
 */
export const deviceCustomerAuditActions={move:'device.customer.move'} as const;
