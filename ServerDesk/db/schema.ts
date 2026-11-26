import {sql} from 'drizzle-orm';
import {bigint,boolean,check,customType,doublePrecision,foreignKey,index,integer,pgTable,pgView,primaryKey,smallint,text,unique,uniqueIndex} from 'drizzle-orm/pg-core';
import {defaultCustomerId} from '../lib/default-customer';

// The PostgreSQL schema. pnpm db:generate writes the tables, indexes and the
// view of drizzle/0000_baseline.sql from this file. Trigger functions,
// triggers and seed rows are written by hand at the end of that migration
// (CONTRIBUTING.md, "Database migrations"). Every integer is bigint, flags
// keep 0/1, JSON stays text and is checked with IS JSON.
export const agentChannels=pgTable('agent_channels',{
 server_id:text('server_id').primaryKey().notNull(),
 last_at:bigint('last_at',{mode:'number'}).notNull()
});
// The integrity events of agent 4.18.0 (lib/server/agent/agent-integrity.ts): a stopped,
// ended, hung, restarted or removed agent, a changed start type and a changed
// protection. One row per device and agent event ID; planned rows (during an
// agent update) are kept but never raise an alarm. The daily maintenance
// deletes rows after 90 days; the device removal deletes them too.
export const agentIntegrityEvents=pgTable('agent_integrity_events',{
 id:text('id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 event_id:text('event_id').notNull(),
 kind:text('kind').notNull(),
 service:text('service'),
 target:text('target'),
 start_type:text('start_type'),
 reason:text('reason'),
 user_name:text('user_name'),
 finding:text('finding'),
 repaired:boolean('repaired'),
 planned:boolean('planned').notNull().default(false),
 occurred_at:bigint('occurred_at',{mode:'number'}).notNull(),
 received_at:bigint('received_at',{mode:'number'}).notNull()
},t=>[
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 unique('agent_integrity_events_server_id_event_id_key').on(t.server_id,t.event_id),
 index('idx_agent_integrity_events_server_received').on(t.server_id,t.received_at),
 // The 90-day retention of the daily maintenance (runtime/maintenance.mjs).
 index('idx_agent_integrity_events_received').on(t.received_at),
 check('agent_integrity_events_kind_check',sql`kind IN ('service-stopped','service-ended','service-hung','service-restarted','broker-unresponsive','start-type-changed','agent-removed','protection-changed')`),
 check('agent_integrity_events_service_check',sql`service IS NULL OR service IN ('broker','worker')`),
 check('agent_integrity_events_target_check',sql`target IS NULL OR target IN ('service-dacl','service-sid','service-recovery','folder-agent','folder-plugins','folder-staging')`),
 check('agent_integrity_events_start_type_check',sql`start_type IS NULL OR start_type IN ('manual','disabled','unknown')`),
 check('agent_integrity_events_reason_check',sql`reason IS NULL OR reason IN ('local-uninstall','service-deleted')`),
 check('agent_integrity_events_user_name_check',sql`user_name IS NULL OR char_length(user_name) <= 256`),
 check('agent_integrity_events_finding_check',sql`finding IS NULL OR char_length(finding) <= 120`)
]);
export const agentReleaseStates=pgTable('agent_release_states',{
 release_id:text('release_id').primaryKey().notNull(),
 state:text('state').notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 updated_by:text('updated_by').notNull()
},()=>[
 check('agent_release_states_state_check',sql`state IN ('disabled','deleted')`)
]);
// The imported plugin releases (runtime/release-import.mjs, docs/agent-plugins.md):
// the exact signed manifest bytes and signature, one row per name and version.
// state disabled keeps the files downloadable but offers the release no more.
export const pluginReleases=pgTable('plugin_releases',{
 id:text('id').primaryKey().notNull(),
 name:text('name').notNull(),
 version:text('version').notNull(),
 manifest:text('manifest').notNull(),
 signature:text('signature').notNull(),
 sha256:text('sha256').notNull(),
 size:bigint('size',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 state:text('state').default('active').notNull()
},t=>[
 unique('plugin_releases_name_version_key').on(t.name,t.version),
 check('plugin_releases_state_check',sql`state IN ('active','disabled')`)
]);
// The files of an imported plugin release, like agent_release_files: one row per
// path of the signed manifest (the EXE and its parts), served under /downloads/.
export const pluginReleaseFiles=pgTable('plugin_release_files',{
 release_id:text('release_id').notNull(),
 path:text('path').notNull(),
 size:bigint('size',{mode:'number'}).notNull(),
 sha256:text('sha256').notNull(),
 chunks:text('chunks').notNull()
},t=>[
 primaryKey({columns:[t.release_id,t.path]}),
 foreignKey({columns:[t.release_id],foreignColumns:[pluginReleases.id]}),
 index('idx_plugin_release_files_path').on(t.path),
 check('plugin_release_files_size_check',sql`size > 0`),
 check('plugin_release_files_sha256_check',sql`sha256 ~ '^[a-f0-9]{64}$'`),
 check('plugin_release_files_chunks_check',sql`chunks IS JSON ARRAY`)
]);
export const agentReleases=pgTable('agent_releases',{
 id:text('id').primaryKey().notNull(),
 version:text('version').notNull(),
 manifest:text('manifest').notNull(),
 signature:text('signature').notNull(),
 size:bigint('size',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 sha256:text('sha256').notNull()
});
// The files of an imported agent release (runtime/release-import.mjs): one row
// per path of its signed manifest, served under /downloads/. chunks is the
// ordered JSON list of 20 MiB chunks [{sha256,size}], each stored once in the
// object storage under agent-releases/sha256/<sha256>.
export const agentReleaseFiles=pgTable('agent_release_files',{
 release_id:text('release_id').notNull(),
 path:text('path').notNull(),
 size:bigint('size',{mode:'number'}).notNull(),
 sha256:text('sha256').notNull(),
 chunks:text('chunks').notNull()
},t=>[
 primaryKey({columns:[t.release_id,t.path]}),
 foreignKey({columns:[t.release_id],foreignColumns:[agentReleases.id]}),
 index('idx_agent_release_files_path').on(t.path),
 check('agent_release_files_size_check',sql`size > 0`),
 check('agent_release_files_sha256_check',sql`sha256 ~ '^[a-f0-9]{64}$'`),
 check('agent_release_files_chunks_check',sql`chunks IS JSON ARRAY`)
]);
// The last result per GitHub release tag or imported folder (agent-vX.Y.Z).
// fingerprint holds the asset ids, sizes and update times of a GitHub release,
// so the daily check skips a permanent failure until the assets change.
export const agentReleaseImports=pgTable('agent_release_imports',{
 tag:text('tag').primaryKey().notNull(),
 source:text('source').notNull(),
 version:text('version').notNull(),
 status:text('status').notNull(),
 reason:text('reason'),
 release_id:text('release_id'),
 fingerprint:text('fingerprint'),
 attempted_at:bigint('attempted_at',{mode:'number'}).notNull(),
 // agent for agent-vX.Y.Z, plugin for plugin-<name>-vX.Y.Z (docs/agent-plugins.md).
 kind:text('kind').default('agent').notNull()
},()=>[
 check('agent_release_imports_source_check',sql`source IN ('github','folder')`),
 check('agent_release_imports_kind_check',sql`kind IN ('agent','plugin')`),
 check('agent_release_imports_status_check',sql`status IN ('imported','present','failed')`),
 check('agent_release_imports_reason_check',sql`(status = 'failed') = (reason IS NOT NULL)`),
 index('idx_agent_release_imports_attempted').on(sql`attempted_at DESC`)
]);
// The single row of the release source nodiverna/nodiverna (a public
// repository, read without sign-in): the lease of the running check and the
// state of the last one.
export const agentReleaseSource=pgTable('agent_release_source',{
 id:smallint('id').primaryKey().notNull(),
 lease_holder:text('lease_holder'),
 lease_until:bigint('lease_until',{mode:'number'}),
 requested_at:bigint('requested_at',{mode:'number'}),
 last_started_at:bigint('last_started_at',{mode:'number'}),
 last_finished_at:bigint('last_finished_at',{mode:'number'}),
 last_status:text('last_status'),
 last_error:text('last_error'),
 // Import dev builds (Settings → Agent releases): the check also imports dev pre-releases, device updates offer them.
 dev_builds:boolean('dev_builds').notNull().default(false)
},()=>[
 check('agent_release_source_single_row',sql`id = 1`),
 check('agent_release_source_status_check',sql`last_status IS NULL OR last_status IN ('ok','failed')`)
]);
// One override of one alert rule (lib/alert-rules.ts) at one scope: the complete
// settings that replace the inherited ones there. scope_id is '*' for global, a
// device_groups.id or a servers.id; triggers remove it with its group or device.
export const alertRuleOverrides=pgTable('alert_rule_overrides',{
 id:text('id').primaryKey().notNull(),
 rule_id:text('rule_id').notNull(),
 scope_type:text('scope_type').notNull(),
 scope_id:text('scope_id').notNull(),
 enabled:smallint('enabled').notNull(),
 warning:integer('warning'),
 critical:integer('critical'),
 level:text('level'),
 duration_minutes:integer('duration_minutes'),
 recovery:integer('recovery'),
 actor:text('actor').notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull()
},t=>[
 check('alert_rule_overrides_scope_type_check',sql`scope_type IN ('global','customer','group','device')`),
 check('alert_rule_overrides_scope_id_check',sql`(scope_type='global') = (scope_id='*')`),
 check('alert_rule_overrides_enabled_check',sql`enabled IN (0,1)`),
 check('alert_rule_overrides_level_check',sql`level IS NULL OR level IN ('info','warning','critical')`),
 unique('alert_rule_overrides_rule_id_scope_type_scope_id_key').on(t.rule_id,t.scope_type,t.scope_id),
 index('idx_alert_rule_overrides_scope').on(t.scope_type,t.scope_id)
]);
// The lease of the periodic alarm check (lib/server/devices/alerts.ts, runAlertSweep): one row;
// a run starts only when the last start is at least 50 seconds old.
export const alertSweep=pgTable('alert_sweep',{
 id:smallint('id').primaryKey().notNull(),
 last_started_at:bigint('last_started_at',{mode:'number'})
},()=>[
 check('alert_sweep_single_row',sql`id = 1`)
]);
// Alarms (lib/server/devices/alerts.ts, lib/server/devices/alert-state.ts): pending while the minimum duration
// runs, open, closed with a reason. At most one alarm that is not closed per
// device, rule and issue key.
export const alerts=pgTable('alerts',{
 id:text('id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 rule_id:text('rule_id').notNull(),
 key:text('key').notNull(),
 state:text('state').notNull(),
 level:text('level').notNull(),
 peak_level:text('peak_level').notNull(),
 peak_value:doublePrecision('peak_value'),
 threshold:integer('threshold'),
 params:text('params').notNull(),
 started_at:bigint('started_at',{mode:'number'}).notNull(),
 opened_at:bigint('opened_at',{mode:'number'}),
 closed_at:bigint('closed_at',{mode:'number'}),
 close_reason:text('close_reason'),
 acknowledged_at:bigint('acknowledged_at',{mode:'number'}),
 acknowledged_by:text('acknowledged_by'),
 muted_until:bigint('muted_until',{mode:'number'}),
 muted_by:text('muted_by')
},t=>[
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('alerts_state_check',sql`state IN ('pending','open','closed')`),
 check('alerts_level_check',sql`level IN ('info','warning','critical')`),
 check('alerts_peak_level_check',sql`peak_level IN ('info','warning','critical')`),
 check('alerts_close_reason_check',sql`close_reason IS NULL OR close_reason IN ('recovered','rule-off','no-data')`),
 check('alerts_closed_check',sql`(state = 'closed') = (closed_at IS NOT NULL) AND (state = 'closed') = (close_reason IS NOT NULL)`),
 check('alerts_opened_check',sql`(state = 'pending') = (opened_at IS NULL)`),
 check('alerts_params_check',sql`params IS JSON`),
 uniqueIndex('idx_alerts_active').on(t.server_id,t.rule_id,t.key).where(sql`state <> 'closed'`),
 index('idx_alerts_server_started').on(t.server_id,t.started_at.desc()),
 index('idx_alerts_closed_at').on(t.closed_at).where(sql`state = 'closed'`)
]);
// The provider keys of the device assistant (lib/server/devices/assistant-settings.ts): one
// organization key that every viewer may use, one personal key per user and one
// key per customer. secret is keyring ciphertext (context assistant-key:organization,
// assistant-key:user:<user_id> or assistant-key:customer:<customer_id>);
// key_hint holds the last 4 characters only.
export const assistantKeys=pgTable('assistant_keys',{
 id:text('id').primaryKey().notNull(),
 scope:text('scope').notNull(),
 user_id:text('user_id'),
 customer_id:text('customer_id'),
 provider:text('provider').notNull(),
 model:text('model').notNull(),
 secret:text('secret').notNull(),
 key_hint:text('key_hint').notNull(),
 revision:bigint('revision',{mode:'number'}).notNull().default(0),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 updated_by:text('updated_by').notNull()
},t=>[
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}).onDelete('cascade'),
 foreignKey({columns:[t.customer_id],foreignColumns:[customers.id]}).onDelete('cascade'),
 check('assistant_keys_scope_check',sql`scope IN ('organization','personal','customer')`),
 check('assistant_keys_user_check',sql`(scope = 'personal') = (user_id IS NOT NULL)`),
 check('assistant_keys_customer_check',sql`(scope = 'customer') = (customer_id IS NOT NULL)`),
 check('assistant_keys_provider_check',sql`provider IN ('anthropic','openai')`),
 check('assistant_keys_model_check',sql`length(model) BETWEEN 1 AND 100`),
 check('assistant_keys_secret_check',sql`secret <> ''`),
 check('assistant_keys_key_hint_check',sql`length(key_hint) <= 4`),
 uniqueIndex('idx_assistant_keys_organization').on(t.scope).where(sql`scope = 'organization'`),
 uniqueIndex('idx_assistant_keys_user').on(t.user_id),
 uniqueIndex('idx_assistant_keys_customer').on(t.customer_id)
]);
// The limits of the device assistant (lib/server/devices/assistant.ts, lib/server/devices/assistant-settings.ts):
// one row per principal and kind with the attempts of its fixed window
// (questions: 20 in 10 minutes; key tests: 5 in 60 seconds).
export const assistantLimits=pgTable('assistant_limits',{
 principal:text('principal').notNull(),
 kind:text('kind').notNull(),
 attempts:integer('attempts').notNull(),
 window_at:bigint('window_at',{mode:'number'}).notNull()
},t=>[
 primaryKey({columns:[t.principal,t.kind]}),
 check('assistant_limits_kind_check',sql`kind IN ('question','test')`)
]);
export const audit=pgTable('audit',{
 id:bigint('id',{mode:'number'}).primaryKey().generatedByDefaultAsIdentity(),
 at:bigint('at',{mode:'number'}).notNull(),
 actor:text('actor').notNull(),
 action:text('action').notNull(),
 target:text('target').notNull(),
 server_id:text('server_id'),
 scope:text('scope').notNull().default('portal'),
 customer_id:text('customer_id')
},t=>[
 check('audit_scope',sql`scope IN ('portal','device')`),
 index('idx_audit_at').on(t.at),
 index('idx_audit_customer_at').on(t.customer_id,t.at),
 index('idx_audit_scope_at').on(t.scope,t.at),
 index('idx_audit_server_at').on(t.server_id,t.at)
]);
// PostgreSQL bytea: the raw bytes of a stored file.
const bytea=customType<{data:Uint8Array;driverData:Uint8Array}>({dataType(){return 'bytea';}});
// The branding images (docs/branding.md, lib/server/branding.ts): the portal
// logo for the light and the dark appearance, the browser tab icon, the
// backgrounds of the sign-in page and the console (portal only), and a logo
// per customer other than the default customer. customer_id NULL is the
// portal. One row per owner and slot; SVG files hold only the cleaned output
// (lib/server/branding-image.ts). size, width and height describe data.
// measure_*: the measured range of the blurred console background (lib/backdrop.ts), sent by the Owner's browser
// after an upload; only for the console slot, all four or none, cleared when new bytes are stored.
export const brandingAssets=pgTable('branding_assets',{
 customer_id:text('customer_id'),
 slot:text('slot').notNull(),
 content_type:text('content_type').notNull(),
 data:bytea('data').notNull(),
 size:integer('size').notNull(),
 width:integer('width').notNull(),
 height:integer('height').notNull(),
 sha256:text('sha256').notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 updated_by:text('updated_by').notNull(),
 measure_light_low:text('measure_light_low'),
 measure_light_high:text('measure_light_high'),
 measure_dark_low:text('measure_dark_low'),
 measure_dark_high:text('measure_dark_high')
},t=>[
 foreignKey({columns:[t.customer_id],foreignColumns:[customers.id]}).onDelete('cascade'),
 uniqueIndex('branding_assets_owner_slot').on(sql`COALESCE(${t.customer_id},'')`,t.slot),
 check('branding_assets_slot',sql`slot IN ('light','dark','icon','signin','console')`),
 check('branding_assets_icon_portal',sql`slot <> 'icon' OR customer_id IS NULL`),
 check('branding_assets_background_portal',sql`slot NOT IN ('signin','console') OR customer_id IS NULL`),
 check('branding_assets_not_default_customer',sql`customer_id IS NULL OR customer_id <> '00000000-0000-4000-8000-000000000100'`),
 check('branding_assets_content_type',sql`content_type IN ('image/png','image/webp','image/jpeg','image/svg+xml')`),
 check('branding_assets_size',sql`size = octet_length(data) AND size >= 1 AND (slot <> 'icon' OR size <= 262144) AND (slot NOT IN ('light','dark') OR size <= 2097152) AND (slot NOT IN ('signin','console') OR size <= 8388608)`),
 check('branding_assets_dimensions',sql`width > 0 AND height > 0`),
 check('branding_assets_sha256',sql`sha256 ~ '^[a-f0-9]{64}$'`),
 check('branding_assets_measure_hex',sql`measure_light_low ~ '^#[0-9a-f]{6}$' AND measure_light_high ~ '^#[0-9a-f]{6}$' AND measure_dark_low ~ '^#[0-9a-f]{6}$' AND measure_dark_high ~ '^#[0-9a-f]{6}$'`),
 check('branding_assets_measure_all',sql`(measure_light_low IS NULL AND measure_light_high IS NULL AND measure_dark_low IS NULL AND measure_dark_high IS NULL) OR (measure_light_low IS NOT NULL AND measure_light_high IS NOT NULL AND measure_dark_low IS NOT NULL AND measure_dark_high IS NOT NULL)`),
 check('branding_assets_measure_console',sql`measure_light_low IS NULL OR slot = 'console'`)
]);
// The portal branding choices (docs/branding.md, lib/server/branding.ts): the
// background of the sign-in page and of the console ('none', 'upload' for the
// stored image of that slot, or a bundled background), and the two colors of
// the brand color scheme (lib/brand-scheme.ts). At most one row (id 1); a
// missing row means none, none and no scheme.
export const brandingSettings=pgTable('branding_settings',{
 id:smallint('id').primaryKey(),
 signin_background:text('signin_background').notNull().default('none'),
 console_background:text('console_background').notNull().default('none'),
 scheme_primary:text('scheme_primary'),
 scheme_secondary:text('scheme_secondary'),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 updated_by:text('updated_by').notNull()
},()=>[
 check('branding_settings_single',sql`id = 1`),
 check('branding_settings_signin_background',sql`signin_background IN ('none','upload','mist','dusk','tide','dune','slate','bloom')`),
 check('branding_settings_console_background',sql`console_background IN ('none','upload','mist','dusk','tide','dune','slate','bloom')`),
 check('branding_settings_scheme_primary',sql`scheme_primary ~ '^#[0-9a-f]{6}$'`),
 check('branding_settings_scheme_secondary',sql`scheme_secondary ~ '^#[0-9a-f]{6}$'`),
 check('branding_settings_scheme_pair',sql`(scheme_primary IS NULL) = (scheme_secondary IS NULL)`)
]);
// The display preferences of one account that follow it to every browser
// (lib/server/account-preferences.ts). A missing row means the defaults.
export const accountPreferences=pgTable('account_preferences',{
 user_id:text('user_id').primaryKey(),
 console_background:boolean('console_background').notNull().default(true),
 // The account's own Dashboard layout as JSON (lib/dashboard-layout.ts); NULL: the account follows the default layout.
 dashboard_layout:text('dashboard_layout'),
 updated_at:bigint('updated_at',{mode:'number'}).notNull()
},t=>[
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}).onDelete('cascade')
]);
// The Owner's default Dashboard layout for accounts without their own (lib/server/dashboard-data.ts), one row at most.
// No row: the built-in layout.
export const dashboardSettings=pgTable('dashboard_settings',{
 id:smallint('id').primaryKey(),
 default_layout:text('default_layout').notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 updated_by:text('updated_by').notNull()
},()=>[
 check('dashboard_settings_single',sql`id = 1`)
]);
// The devices one account pinned to the top of its navigator and command
// palette (lib/server/pinned-devices.ts). At most 20 per account, a rule of
// the application. The rows go with the account or the device.
export const accountPinnedDevices=pgTable('account_pinned_devices',{
 user_id:text('user_id').notNull(),
 device_id:text('device_id').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull()
},t=>[
 primaryKey({columns:[t.user_id,t.device_id]}),
 index('idx_account_pinned_devices_device').on(t.device_id),
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}).onDelete('cascade'),
 foreignKey({columns:[t.device_id],foreignColumns:[servers.id]}).onDelete('cascade')
]);
export const automationDeviceState=pgTable('automation_device_state',{
 server_id:text('server_id').notNull(),
 kind:text('kind').notNull(),
 slot:text('slot').notNull(),
 assignment_id:text('assignment_id'),
 fingerprint:text('fingerprint'),
 resource_id:text('resource_id'),
 resource_fingerprint:text('resource_fingerprint'),
 status:text('status').notNull(),
 message:text('message').notNull().default(''),
 updated_at:bigint('updated_at',{mode:'number'}).notNull()
},t=>[
 primaryKey({columns:[t.server_id,t.kind,t.slot]})
]);
export const automationRunbookRuns=pgTable('automation_runbook_runs',{
 run_id:text('run_id').primaryKey().notNull().references(()=>runbookRuns.id),
 assignment_id:text('assignment_id').notNull(),
 effective:text('effective').notNull(),
 execution_actor:text('execution_actor').notNull(),
 auth_version:bigint('auth_version',{mode:'number'}).notNull(),
 creation_token:text('creation_token').notNull()
},t=>[
 check('automation_runbook_runs_effective_check',sql`effective IS JSON`),
 index('idx_automation_runbook_assignment').on(t.assignment_id)
]);
export const automationRunbookSchedules=pgTable('automation_runbook_schedules',{
 assignment_id:text('assignment_id').primaryKey().notNull(),
 next_due:bigint('next_due',{mode:'number'}).notNull(),
 last_due:bigint('last_due',{mode:'number'}),
 created_at:bigint('created_at',{mode:'number'}).notNull()
},t=>[
 index('idx_automation_runbook_due').on(t.next_due)
]);
export const automationScopeAssignments=pgTable('automation_scope_assignments',{
 id:text('id').primaryKey().notNull(),
 kind:text('kind').notNull(),
 slot:text('slot').notNull(),
 scope_type:text('scope_type').notNull(),
 scope_id:text('scope_id').notNull(),
 template_id:text('template_id').notNull().references(()=>automationTemplates.id),
 disabled:bigint('disabled',{mode:'number'}).notNull().default(0),
 actor:text('actor').notNull(),
 auth_version:bigint('auth_version',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull()
},t=>[
 check('automation_scope_assignments_kind_check',sql`kind IN ('drift','desired','runbook')`),
 check('automation_scope_assignments_scope_type_check',sql`scope_type IN ('group','device')`),
 check('automation_scope_assignments_disabled_check',sql`disabled IN (0,1)`),
 unique('automation_scope_assignments_kind_slot_scope_type_scope_id_key').on(t.kind,t.slot,t.scope_type,t.scope_id),
 index('idx_automation_runbook_slot').on(t.kind,t.slot),
 index('idx_automation_scope').on(t.scope_type,t.scope_id,t.kind)
]);
export const automationTemplates=pgTable('automation_templates',{
 id:text('id').primaryKey().notNull(),
 kind:text('kind').notNull(),
 slot:text('slot').notNull(),
 name:text('name').notNull(),
 payload:text('payload').notNull(),
 created_by:text('created_by').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 archived:bigint('archived',{mode:'number'}).notNull().default(0),
 customer_id:text('customer_id')
},t=>[
 check('automation_templates_kind_check',sql`kind IN ('drift','desired','runbook')`),
 check('automation_templates_payload_check',sql`payload IS JSON`),
 check('automation_templates_archived_check',sql`archived IN (0,1)`),
 index('idx_automation_templates_customer').on(t.customer_id)
]);
export const customerAssignments=pgTable('customer_assignments',{
 customer_id:text('customer_id').notNull(),
 principal_type:text('principal_type').notNull(),
 principal_id:text('principal_id').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull()
},t=>[
 primaryKey({columns:[t.customer_id,t.principal_type,t.principal_id]}),
 check('customer_assignments_principal_type',sql`principal_type IN ('user','group')`),
 index('customer_assignments_subject').on(t.principal_type,t.principal_id)
]);
export const customerInstallers=pgTable('customer_installers',{
 id:text('id').primaryKey().notNull(),
 customer_id:text('customer_id').notNull(),
 group_id:text('group_id'),
 name:text('name').notNull(),
 key_hash:text('key_hash').notNull(),
 mode:text('mode').notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull(),
 max_devices:bigint('max_devices',{mode:'number'}),
 enrollments:bigint('enrollments',{mode:'number'}).notNull().default(0),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull(),
 last_used_at:bigint('last_used_at',{mode:'number'}),
 revoked_at:bigint('revoked_at',{mode:'number'}),
 revoked_by:text('revoked_by')
},t=>[
 check('customer_installers_name_present',sql`length(btrim(name, E' \\t\\n\\r'))>0`),
 check('customer_installers_mode',sql`mode IN ('ReadOnly','Management')`),
 check('customer_installers_max_devices',sql`max_devices IS NULL OR (max_devices BETWEEN 1 AND 10000)`),
 check('customer_installers_enrollments',sql`enrollments>=0 AND (max_devices IS NULL OR enrollments<=max_devices)`),
 index('customer_installers_customer').on(t.customer_id),
 uniqueIndex('customer_installers_key_hash').on(t.key_hash)
]);
// The setting "Multiple customers" (lib/server/identity/multiple-customers.ts,
// docs/customers.md): one row. While multiple_customers is false, no customer
// other than the default customer exists; the triggers of the migration hold it.
export const customerSettings=pgTable('customer_settings',{
 id:smallint('id').primaryKey().notNull(),
 multiple_customers:boolean('multiple_customers').notNull(),
 revision:bigint('revision',{mode:'number'}).notNull().default(0),
 updated_at:bigint('updated_at',{mode:'number'}),
 updated_by:text('updated_by')
},()=>[
 check('customer_settings_single_row',sql`id = 1`),
 check('customer_settings_revision',sql`revision >= 0`)
]);
export const customers=pgTable('customers',{
 id:text('id').primaryKey().notNull(),
 name:text('name').notNull(),
 status:text('status').notNull().default('active'),
 contact_name:text('contact_name').notNull().default(''),
 contact_email:text('contact_email').notNull().default(''),
 contact_phone:text('contact_phone').notNull().default(''),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 audit_retention_days:bigint('audit_retention_days',{mode:'number'}),
 maintenance_days:bigint('maintenance_days',{mode:'number'}),
 maintenance_start:bigint('maintenance_start',{mode:'number'}),
 maintenance_duration:bigint('maintenance_duration',{mode:'number'}),
 maintenance_time_zone:text('maintenance_time_zone'),
 revision:bigint('revision',{mode:'number'}).notNull().default(0)
},t=>[
 check('customers_name_present',sql`length(btrim(name, E' \\t\\n\\r'))>0`),
 check('customers_status',sql`status IN ('active','disabled')`),
 // Per-customer settings: retention 1-3650 days or the instance default (NULL);
 // the four maintenance columns all NULL (no window) or all valid.
 check('customers_settings_valid',sql`(audit_retention_days IS NULL OR audit_retention_days BETWEEN 1 AND 3650) AND ((maintenance_days IS NULL AND maintenance_start IS NULL AND maintenance_duration IS NULL AND maintenance_time_zone IS NULL) OR (maintenance_days IS NOT NULL AND maintenance_start IS NOT NULL AND maintenance_duration IS NOT NULL AND maintenance_time_zone IS NOT NULL AND maintenance_days BETWEEN 1 AND 127 AND maintenance_start BETWEEN 0 AND 1425 AND maintenance_start%15=0 AND maintenance_duration BETWEEN 15 AND 720 AND maintenance_duration%15=0 AND length(maintenance_time_zone) BETWEEN 1 AND 64)) AND revision>=0`),
 uniqueIndex('customers_name').on(sql`lower(${t.name})`)
]);
// Tombstones of deleted customers (docs/customers.md, "Delete a customer"): the
// trigger customers_delete_tombstone writes the id and the last name. History
// rows (audit, notification events, revoked devices, archived catalog entries)
// keep the id, and the audit log shows the name from here. Append-only; a
// removed id is never inserted into customers again.
export const removedCustomers=pgTable('removed_customers',{
 id:text('id').primaryKey().notNull(),
 name:text('name').notNull(),
 removed_at:bigint('removed_at',{mode:'number'}).notNull()
});
export const desiredAssignments=pgTable('desired_assignments',{
 id:text('id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 version_id:text('version_id').notNull(),
 assigned_by:text('assigned_by').notNull(),
 assigned_at:bigint('assigned_at',{mode:'number'}).notNull(),
 enabled:bigint('enabled',{mode:'number'}).notNull().default(1),
 interval_seconds:bigint('interval_seconds',{mode:'number'}).notNull().default(0),
 last_checked_at:bigint('last_checked_at',{mode:'number'}),
 last_job_id:text('last_job_id'),
 last_result_state:text('last_result_state'),
 last_result_at:bigint('last_result_at',{mode:'number'}),
 last_compliant:bigint('last_compliant',{mode:'number'}),
 last_compliant_at:bigint('last_compliant_at',{mode:'number'})
},t=>[
 check('desired_assignment_last_result_state',sql`last_result_state IN ('succeeded','failed')`),
 check('desired_assignment_last_result',sql`(last_job_id IS NULL AND last_result_state IS NULL AND last_result_at IS NULL) OR (last_job_id IS NOT NULL AND last_result_state IS NOT NULL AND last_result_at IS NOT NULL)`),
 check('desired_assignment_last_compliant',sql`last_compliant IN (0,1)`),
 check('desired_assignment_last_compliance',sql`(last_compliant IS NULL) = (last_compliant_at IS NULL)`),
 uniqueIndex('idx_desired_assignment').on(t.server_id)
]);
export const desiredConfigs=pgTable('desired_configs',{
 id:text('id').primaryKey().notNull(),
 name:text('name').notNull(),
 description:text('description').notNull().default(''),
 created_by:text('created_by').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 archived:bigint('archived',{mode:'number'}).notNull().default(0)
});
export const desiredRuns=pgTable('desired_runs',{
 id:text('id').primaryKey().notNull(),
 assignment_id:text('assignment_id').notNull(),
 server_id:text('server_id').notNull(),
 version_id:text('version_id').notNull(),
 job_id:text('job_id').notNull(),
 operation:text('operation').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull()
},t=>[
 uniqueIndex('idx_desired_run_job').on(t.job_id),
 index('idx_desired_runs_device').on(t.server_id,t.created_at)
]);
export const desiredVersions=pgTable('desired_versions',{
 id:text('id').primaryKey().notNull(),
 config_id:text('config_id').notNull(),
 version:bigint('version',{mode:'number'}).notNull(),
 engine:text('engine').notNull(),
 content:text('content').notNull(),
 sha256:text('sha256').notNull(),
 configuration_name:text('configuration_name'),
 parameters:text('parameters').notNull().default('{}'),
 source:text('source').notNull().default('{}'),
 created_by:text('created_by').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull()
},t=>[
 uniqueIndex('idx_desired_version').on(t.config_id,t.version)
]);
export const deviceGroupMembers=pgTable('device_group_members',{
 server_id:text('server_id').notNull(),
 group_id:text('group_id').notNull()
},t=>[
 primaryKey({columns:[t.server_id,t.group_id]}),
 index('idx_device_group_members_group').on(t.group_id),
 uniqueIndex('idx_device_group_members_server').on(t.server_id)
]);
export const deviceGroupPaths=pgTable('device_group_paths',{
 group_id:text('group_id').notNull(),
 ancestor_id:text('ancestor_id').notNull(),
 depth:bigint('depth',{mode:'number'}).notNull()
},t=>[
 primaryKey({columns:[t.group_id,t.ancestor_id]}),
 check('device_group_paths_depth_check',sql`depth BETWEEN 0 AND 4`),
 check('device_group_paths_check',sql`(depth=0) = (group_id=ancestor_id)`),
 index('idx_device_group_paths_ancestor').on(t.ancestor_id,t.group_id,t.depth)
]);
export const deviceGroups=pgTable('device_groups',{
 id:text('id').primaryKey().notNull(),
 name:text('name').notNull(),
 description:text('description').notNull().default(''),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 parent_id:text('parent_id'),
 customer_id:text('customer_id').notNull().default(defaultCustomerId)
},t=>[
 index('idx_device_groups_customer').on(t.customer_id),
 index('idx_device_groups_parent').on(t.parent_id)
]);
export const deviceLeases=pgTable('device_leases',{
 server_id:text('server_id').primaryKey().notNull(),
 owner_kind:text('owner_kind').notNull(),
 owner_id:text('owner_id').notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull()
});
// The latest result of one plugin operation per device (lib/server/extensions/plugin-data.ts):
// the plugin's data as the agent uploaded it, its time on the device and its
// arrival. summary is a small JSON list for fleet views (the DHCP scope usage),
// so they never read the full data. Removed with the device (revoked=1, trigger)
// and when the plugin is removed from the device.
export const devicePluginData=pgTable('device_plugin_data',{
 server_id:text('server_id').notNull(),
 plugin:text('plugin').notNull(),
 operation:text('operation').notNull(),
 data:text('data').notNull(),
 summary:text('summary').notNull(),
 collected_at:bigint('collected_at',{mode:'number'}).notNull(),
 received_at:bigint('received_at',{mode:'number'}).notNull(),
 // The DHCP service state of the read (0020): the DHCP alert rules read it without the full data.
 service:text('service')
},t=>[
 primaryKey({columns:[t.server_id,t.plugin,t.operation],name:'device_plugin_data_pkey'}),
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_plugin_data_data_check',sql`data IS JSON OBJECT`),
 check('device_plugin_data_summary_check',sql`summary IS JSON ARRAY`),
 check('device_plugin_data_service_check',sql`service IN ('running','stopped')`)
]);
// The records of one DNS zone (0025_dns_zone_records.sql, docs/dns-server.md): the latest dns-zone-read
// or record change of the DNS plugin per device and zone. The revoke trigger
// agent_plugins_removed_device deletes them with the device's plugin data.
export const deviceDnsZoneRecords=pgTable('device_dns_zone_records',{
 server_id:text('server_id').notNull(),
 zone:text('zone').notNull(),
 data:text('data').notNull(),
 record_count:integer('record_count').notNull(),
 truncated:boolean('truncated').notNull(),
 collected_at:bigint('collected_at',{mode:'number'}).notNull(),
 received_at:bigint('received_at',{mode:'number'}).notNull()
},t=>[
 primaryKey({columns:[t.server_id,t.zone],name:'device_dns_zone_records_pkey'}),
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_dns_zone_records_data_check',sql`data IS JSON OBJECT`)
]);
// The last names of a device before a rename (lib/device-name.ts,
// lib/server/agent/heartbeat.ts, lib/server/devices/device-name-store.ts): at most 5 per device, newest
// first by replaced_at, one row per name_key = lower(name). The fleet search
// and the command palette find a renamed device by them. A removal keeps them
// (the device row stays with revoked=1); the row goes with the device row.
export const devicePreviousNames=pgTable('device_previous_names',{
 server_id:text('server_id').notNull(),
 name:text('name').notNull(),
 name_key:text('name_key').notNull(),
 replaced_at:bigint('replaced_at',{mode:'number'}).notNull()
},t=>[
 primaryKey({columns:[t.server_id,t.name_key],name:'device_previous_names_pkey'}),
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_previous_names_name_key_check',sql`name_key<>''`)
]);
// The software inventory of a device (lib/server/devices/software.ts): the current list, the
// state of the last report and the change history. architecture is '' for
// user entries (the wire format sends null), so it can be part of the key.
// A trigger empties all three when the device is removed (revoked=1).
export const deviceSoftware=pgTable('device_software',{
 server_id:text('server_id').notNull(),
 key:text('key').notNull(),
 scope:text('scope').notNull(),
 architecture:text('architecture').notNull(),
 name:text('name').notNull(),
 normalized_name:text('normalized_name').notNull(),
 version:text('version'),
 normalized_version:text('normalized_version'),
 publisher:text('publisher'),
 install_date:text('install_date'),
 first_seen:bigint('first_seen',{mode:'number'}).notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull()
},t=>[
 primaryKey({columns:[t.server_id,t.scope,t.architecture,t.key],name:'device_software_pkey'}),
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_software_scope_check',sql`scope IN ('machine','user')`),
 index('idx_device_software_normalized').on(t.normalized_name,t.normalized_version)
]);
export const deviceSoftwareChanges=pgTable('device_software_changes',{
 id:bigint('id',{mode:'number'}).primaryKey().generatedByDefaultAsIdentity(),
 server_id:text('server_id').notNull(),
 at:bigint('at',{mode:'number'}).notNull(),
 change:text('change').notNull(),
 name:text('name').notNull(),
 normalized_name:text('normalized_name').notNull(),
 version_from:text('version_from'),
 version_to:text('version_to'),
 publisher:text('publisher'),
 architecture:text('architecture'),
 scope:text('scope').notNull()
},t=>[
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_software_changes_change_check',sql`change IN ('installed','updated','removed')`),
 check('device_software_changes_scope_check',sql`scope IN ('machine','user')`),
 index('idx_device_software_changes_server_at').on(t.server_id,t.at),
 index('idx_device_software_changes_at').on(t.at)
]);
export const deviceSoftwareState=pgTable('device_software_state',{
 server_id:text('server_id').primaryKey().notNull(),
 checksum:text('checksum').notNull(),
 reported_at:bigint('reported_at',{mode:'number'}).notNull(),
 count:integer('count').notNull(),
 truncated:smallint('truncated').notNull()
},t=>[
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_software_state_truncated_check',sql`truncated IN (0,1)`)
]);
// The driver inventory of a device (lib/server/devices/drivers.ts): the current list and the
// state of the last report, without a change history. key is the hashed device
// ID the agent sends. A trigger empties both when the device is removed (revoked=1).
export const deviceDrivers=pgTable('device_drivers',{
 server_id:text('server_id').notNull(),
 key:text('key').notNull(),
 device_name:text('device_name').notNull(),
 device_class:text('device_class'),
 inf_name:text('inf_name'),
 file:text('file'),
 service:text('service'),
 provider:text('provider'),
 version:text('version'),
 driver_date:text('driver_date'),
 signed:smallint('signed'),
 signer:text('signer')
},t=>[
 primaryKey({columns:[t.server_id,t.key],name:'device_drivers_pkey'}),
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_drivers_signed_check',sql`signed IS NULL OR signed IN (0,1)`),
 index('idx_device_drivers_inf_version').on(t.inf_name,t.version)
]);
export const deviceDriverState=pgTable('device_driver_state',{
 server_id:text('server_id').primaryKey().notNull(),
 checksum:text('checksum').notNull(),
 reported_at:bigint('reported_at',{mode:'number'}).notNull(),
 count:integer('count').notNull(),
 truncated:smallint('truncated').notNull()
},t=>[
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_driver_state_truncated_check',sql`truncated IN (0,1)`)
]);
// The autostart list of a device (lib/server/devices/autostart.ts). The first report is the
// baseline (baseline=1); later entries are new until someone confirms them
// (acknowledged_at). A trigger empties both when the device is removed (revoked=1).
export const deviceAutostart=pgTable('device_autostart',{
 server_id:text('server_id').notNull(),
 id:text('id').notNull(),
 category:text('category').notNull(),
 scope:text('scope').notNull(),
 location:text('location').notNull(),
 name:text('name').notNull(),
 command:text('command').notNull(),
 target:text('target'),
 signature:text('signature').notNull(),
 signer:text('signer'),
 publisher:text('publisher'),
 microsoft:smallint('microsoft').notNull(),
 user_path:smallint('user_path').notNull(),
 first_seen:bigint('first_seen',{mode:'number'}).notNull(),
 baseline:smallint('baseline').notNull(),
 acknowledged_at:bigint('acknowledged_at',{mode:'number'}),
 acknowledged_by:text('acknowledged_by')
},t=>[
 primaryKey({columns:[t.server_id,t.id],name:'device_autostart_pkey'}),
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_autostart_category_check',sql`category IN ('run','run-once','startup-folder','winlogon','service','task')`),
 check('device_autostart_scope_check',sql`scope IN ('machine','user')`),
 check('device_autostart_signature_check',sql`signature IN ('valid','invalid','unsigned','unknown')`),
 check('device_autostart_flags_check',sql`microsoft IN (0,1) AND user_path IN (0,1) AND baseline IN (0,1)`),
 index('idx_device_autostart_name_target').on(t.name,t.target)
]);
export const deviceAutostartState=pgTable('device_autostart_state',{
 server_id:text('server_id').primaryKey().notNull(),
 checksum:text('checksum').notNull(),
 reported_at:bigint('reported_at',{mode:'number'}).notNull(),
 count:integer('count').notNull(),
 truncated:smallint('truncated').notNull(),
 baseline_at:bigint('baseline_at',{mode:'number'}).notNull()
},t=>[
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}).onDelete('cascade'),
 check('device_autostart_state_truncated_check',sql`truncated IN (0,1)`)
]);
export const deviceTokenNonces=pgTable('device_token_nonces',{
 nonce_hash:text('nonce_hash').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull()
},t=>[
 index('idx_device_token_nonces_expiry').on(t.expires_at)
]);
export const driftBaselines=pgTable('drift_baselines',{
 id:text('id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 policy_version:bigint('policy_version',{mode:'number'}).notNull(),
 report_id:text('report_id').notNull(),
 entries:text('entries').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull()
},t=>[
 index('idx_drift_baselines_server').on(t.server_id,t.created_at)
]);
export const driftPolicies=pgTable('drift_policies',{
 server_id:text('server_id').primaryKey().notNull(),
 id:text('id').notNull(),
 version:bigint('version',{mode:'number'}).notNull(),
 enabled:bigint('enabled',{mode:'number'}).notNull().default(0),
 policy:text('policy').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 updated_by:text('updated_by').notNull()
});
export const driftReports=pgTable('drift_reports',{
 id:text('id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 policy_version:bigint('policy_version',{mode:'number'}).notNull(),
 scan_id:text('scan_id').notNull(),
 received_at:bigint('received_at',{mode:'number'}).notNull(),
 scanned_at:bigint('scanned_at',{mode:'number'}).notNull(),
 complete:bigint('complete',{mode:'number'}).notNull(),
 state:text('state').notNull(),
 entries:text('entries').notNull(),
 changes:text('changes').notNull(),
 errors:text('errors').notNull(),
 acknowledged_at:bigint('acknowledged_at',{mode:'number'}),
 acknowledged_by:text('acknowledged_by'),
 first_scanned_at:bigint('first_scanned_at',{mode:'number'}),
 scan_count:bigint('scan_count',{mode:'number'}).notNull().default(1),
 last_scan_id:text('last_scan_id'),
 baseline_id:text('baseline_id')
},t=>[
 index('idx_drift_reports_server').on(t.server_id,t.received_at),
 uniqueIndex('idx_drift_reports_server_id_scan_id').on(t.server_id,t.scan_id)
]);
// Sign-in with Microsoft Entra ID (lib/server/identity/entra/, docs/entra-id.md). One row
// (id=1) with the app registration of one tenant. secret_enc and
// private_key_enc are keyring ciphertext (contexts entra:client-secret and
// entra:private-key). revision counts the changes of tenant, client and
// credential; a test result counts only while tested_revision equals it.
export const entraSettings=pgTable('entra_settings',{
 id:smallint('id').primaryKey().notNull(),
 enabled:smallint('enabled').notNull().default(0),
 tenant_id:text('tenant_id'),
 client_id:text('client_id'),
 credential_kind:text('credential_kind').notNull().default('secret'),
 secret_enc:text('secret_enc'),
 certificate_pem:text('certificate_pem'),
 private_key_enc:text('private_key_enc'),
 certificate_thumbprint:text('certificate_thumbprint'),
 certificate_expires_at:bigint('certificate_expires_at',{mode:'number'}),
 revision:bigint('revision',{mode:'number'}).notNull().default(0),
 tested_revision:bigint('tested_revision',{mode:'number'}),
 tested_at:bigint('tested_at',{mode:'number'}),
 test_result:text('test_result'),
 updated_at:bigint('updated_at',{mode:'number'}),
 updated_by:text('updated_by'),
 // Microsoft sign-in only (docs/entra-id.md): every built-in account but the
 // emergency access account is locked while entra_only=1.
 entra_only:smallint('entra_only').notNull().default(0),
 emergency_user_id:text('emergency_user_id'),
 entra_only_at:bigint('entra_only_at',{mode:'number'}),
 entra_only_by:text('entra_only_by')
},t=>[
 foreignKey({columns:[t.emergency_user_id],foreignColumns:[localUsers.id]}),
 check('entra_settings_entra_only',sql`entra_only IN (0,1)`),
 check('entra_settings_emergency',sql`entra_only = 0 OR emergency_user_id IS NOT NULL`),
 check('entra_settings_single_row',sql`id = 1`),
 check('entra_settings_enabled',sql`enabled IN (0,1)`),
 check('entra_settings_credential_kind',sql`credential_kind IN ('secret','certificate')`),
 check('entra_settings_test_result',sql`test_result IS NULL OR test_result IN ('ok','tenantNotFound','discoveryFailed','credentialRefused','secretExpired','certificateRefused','unreachable','graphPermissionMissing','graphUnreachable','apiNotExposed','apiTokenVersion')`),
 check('entra_settings_revision',sql`revision >= 0`),
 check('entra_settings_complete',sql`enabled = 0 OR (tenant_id IS NOT NULL AND client_id IS NOT NULL AND ((credential_kind = 'secret' AND secret_enc IS NOT NULL) OR (credential_kind = 'certificate' AND certificate_pem IS NOT NULL AND private_key_enc IS NOT NULL AND certificate_thumbprint IS NOT NULL)))`)
]);
// The account check through Microsoft Graph (lib/server/identity/entra/directory-check.ts):
// one row (id=1), seeded by the migration. lease_until holds a running check;
// a check starts at least 15 minutes after last_started_at. The result and the
// counts are those of the last finished run.
export const entraDirectoryCheck=pgTable('entra_directory_check',{
 id:smallint('id').primaryKey().notNull(),
 lease_until:bigint('lease_until',{mode:'number'}),
 last_started_at:bigint('last_started_at',{mode:'number'}),
 last_finished_at:bigint('last_finished_at',{mode:'number'}),
 last_result:text('last_result'),
 last_ok_at:bigint('last_ok_at',{mode:'number'}),
 settings_revision:bigint('settings_revision',{mode:'number'}),
 checked_count:integer('checked_count').notNull().default(0),
 locked_count:integer('locked_count').notNull().default(0),
 group_change_count:integer('group_change_count').notNull().default(0),
 remaining_count:integer('remaining_count').notNull().default(0)
},()=>[
 check('entra_directory_check_single_row',sql`id = 1`),
 check('entra_directory_check_result',sql`last_result IS NULL OR last_result IN ('ok','permissionMissing','credentialRefused','secretExpired','certificateRefused','unavailable')`),
 check('entra_directory_check_counts',sql`checked_count >= 0 AND locked_count >= 0 AND group_change_count >= 0 AND remaining_count >= 0`)
]);
// Entra group → portal role. The role sync (lib/server/identity/entra/role-sync.ts) turns these
// rows into role_assignments with source 'entra' at every sign-in.
export const entraGroupRoles=pgTable('entra_group_roles',{
 id:text('id').primaryKey().notNull(),
 group_object_id:text('group_object_id').notNull(),
 group_name:text('group_name').notNull().default(''),
 role_id:text('role_id').notNull(),
 scope_type:text('scope_type').notNull(),
 scope_id:text('scope_id').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull()
},t=>[
 foreignKey({columns:[t.role_id],foreignColumns:[rbacRoles.id]}),
 check('entra_group_roles_group_id',sql`group_object_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`),
 check('entra_group_roles_group_name',sql`length(group_name) <= 120`),
 check('entra_group_roles_scope_type',sql`scope_type IN ('global','devicegroup')`),
 check('entra_group_roles_global',sql`(scope_type = 'global') = (scope_id = '*')`),
 uniqueIndex('entra_group_roles_unique').on(t.group_object_id,t.role_id,t.scope_type,t.scope_id)
]);
// The Entra groups of an account at its last sign-in.
export const entraUserGroups=pgTable('entra_user_groups',{
 user_id:text('user_id').notNull(),
 group_object_id:text('group_object_id').notNull()
},t=>[
 primaryKey({columns:[t.user_id,t.group_object_id]}),
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}).onDelete('cascade')
]);
// One row per started Entra sign-in: valid 10 minutes, used once. The browser
// token, state and nonce are stored only as SHA-256 hashes; the PKCE verifier
// is keyring ciphertext (context entra:code-verifier). At most 1000 open rows.
export const entraSignInFlows=pgTable('entra_sign_in_flows',{
 state_hash:text('state_hash').primaryKey().notNull(),
 browser_hash:text('browser_hash').notNull(),
 nonce_hash:text('nonce_hash').notNull(),
 code_verifier_enc:text('code_verifier_enc').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull(),
 // The address bucket and window of the start's attempt (lib/server/identity/local-auth.ts), given back by a successful sign-in.
 attempt_bucket:text('attempt_bucket').notNull(),
 attempt_window_at:bigint('attempt_window_at',{mode:'number'}).notNull(),
 // 'confirm' (docs/entra-id.md, "Confirm with Microsoft"): a fresh Microsoft
 // sign-in of the signed-in Entra account `user_id` that started it from the
 // primary session `primary_hash`. The opener claims the result with the claim
 // handle (only its SHA-256 hash `claim_hash` is stored). The callback sets
 // `confirmed_at` or the refusal code `outcome`.
 purpose:text('purpose').notNull().default('sign-in'),
 user_id:text('user_id'),
 primary_hash:text('primary_hash'),
 claim_hash:text('claim_hash'),
 settings_revision:bigint('settings_revision',{mode:'number'}),
 confirmed_at:bigint('confirmed_at',{mode:'number'}),
 outcome:text('outcome'),
 // A sign-in through an MFA grant: the SHA-256 of the grant token the start
 // read from the cookie. Such a flow sends no prompt; the callback accepts it
 // only while that grant is live and belongs to the signed-in account.
 grant_hash:text('grant_hash')
},t=>[
 index('idx_entra_sign_in_flows_expires').on(t.expires_at),
 uniqueIndex('entra_sign_in_flows_claim').on(t.claim_hash),
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}).onDelete('cascade'),
 check('entra_sign_in_flows_purpose',sql`purpose IN ('sign-in','confirm')`),
 check('entra_sign_in_flows_confirm_fields',sql`(purpose = 'confirm' AND user_id IS NOT NULL AND primary_hash IS NOT NULL AND claim_hash IS NOT NULL AND settings_revision IS NOT NULL) OR (purpose = 'sign-in' AND user_id IS NULL AND primary_hash IS NULL AND claim_hash IS NULL AND settings_revision IS NULL AND confirmed_at IS NULL AND outcome IS NULL)`),
 check('entra_sign_in_flows_result',sql`confirmed_at IS NULL OR outcome IS NULL`),
 check('entra_sign_in_flows_grant',sql`grant_hash IS NULL OR purpose = 'sign-in'`),
 check('entra_sign_in_flows_outcome',sql`outcome IS NULL OR outcome IN ('cancelled','expired','mfaMissing','apiSetupMissing','wrongTenant','wrongAccount','staleSignIn','accountDisabled','tokenRejected','unavailable','notConfigured')`)
]);
export const identitySettings=pgTable('identity_settings',{
 key:text('key').primaryKey().notNull(),
 value:text('value').notNull()
});
export const jobOutputs=pgTable('job_outputs',{
 job_id:text('job_id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 data:text('data').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull()
},t=>[
 index('idx_job_outputs_created_at').on(t.created_at)
]);
export const jobs=pgTable('jobs',{
 id:text('id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 action:text('action').notNull(),
 target:text('target').notNull(),
 state:text('state').notNull().default('pending'),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 claimed_at:bigint('claimed_at',{mode:'number'}),
 result:text('result'),
 actor:text('actor').notNull(),
 parameters:text('parameters').notNull().default('{}'),
 last_progress:bigint('last_progress',{mode:'number'}),
 actor_email:text('actor_email'),
 not_before:bigint('not_before',{mode:'number'}).notNull().default(0),
 result_code:text('result_code'),
 result_args:text('result_args'),
 // The portal principal of the queuing account (lib/server/identity/access.ts principal()):
 // every claim guard and ownership check uses it, never a key rebuilt from
 // actor_email (an Entra account's principal is entra:<tid>:<oid>).
 actor_principal:text('actor_principal'),
 // The concurrency class and group of a running job (lib/server/devices/jobs/concurrency.ts),
 // written by the claim. Every claim guard reads a NULL (a job claimed before
 // 0029) as 'sole'.
 concurrency:text('concurrency'),
 concurrency_group:text('concurrency_group'),
 // A display-safe copy of the input (lib/job-input.ts jobDisplayInput): the
 // allowlisted fields of the kind, never a secret. The statements that wipe
 // parameters when a job ends leave it, so the job drawer can show what ran.
 display_input:text('display_input').notNull().default('{}')
},t=>[
 check('jobs_actor_principal',sql`(actor_principal IS NULL) = (actor_email IS NULL)`),
 check('jobs_concurrency',sql`concurrency IS NULL OR concurrency IN ('parallel','exclusive','sole')`),
 index('idx_jobs_created_at').on(t.created_at),
 // The assistant scripts that runMaintenance still has to remove from display_input
 // (runtime/maintenance.mjs maintenanceSelections.assistantScripts, same predicate).
 index('idx_jobs_assistant_script').on(t.created_at).where(sql`action = 'assistant-powershell' AND display_input LIKE '%"script":%'`),
 index('idx_jobs_server_state').on(t.server_id,t.state)
]);
export const localAccountTokens=pgTable('local_account_tokens',{
 token_hash:text('token_hash').primaryKey().notNull(),
 user_id:text('user_id').notNull(),
 kind:text('kind').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull(),
 used_at:bigint('used_at',{mode:'number'}),
 auth_version:bigint('auth_version',{mode:'number'}).notNull()
},t=>[
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}).onDelete('cascade'),
 check('local_account_token_kind',sql`kind IN ('invite','reset')`),
 index('local_account_tokens_user').on(t.user_id)
]);
export const localAuthAttempts=pgTable('local_auth_attempts',{
 bucket:text('bucket').primaryKey().notNull(),
 attempts:bigint('attempts',{mode:'number'}).notNull(),
 window_at:bigint('window_at',{mode:'number'}).notNull(),
 blocked_until:bigint('blocked_until',{mode:'number'}).notNull()
});
export const localAuthSessions=pgTable('local_auth_sessions',{
 token_hash:text('token_hash').primaryKey().notNull(),
 user_id:text('user_id').notNull(),
 auth_version:bigint('auth_version',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull(),
 pending_until:bigint('pending_until',{mode:'number'}).notNull(),
 mfa_hash:text('mfa_hash')
},t=>[
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}).onDelete('cascade'),
 index('local_auth_sessions_expiry').on(t.expires_at),
 index('local_auth_sessions_user').on(t.user_id)
]);
export const localUsers=pgTable('local_users',{
 id:text('id').primaryKey().notNull(),
 username:text('username').notNull(),
 email:text('email').notNull().default(''),
 display_name:text('display_name').notNull(),
 auth_principal:text('auth_principal').notNull(),
 auth_email:text('auth_email').notNull(),
 status:text('status').notNull().default('invited'),
 password_hash:text('password_hash'),
 auth_version:bigint('auth_version',{mode:'number'}).notNull().default(1),
 must_reset:bigint('must_reset',{mode:'number'}).notNull().default(0),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 last_login_at:bigint('last_login_at',{mode:'number'}),
 // 'entra': created by the first sign-in with Microsoft Entra ID; no password.
 identity_source:text('identity_source').notNull().default('local'),
 entra_tenant_id:text('entra_tenant_id'),
 entra_object_id:text('entra_object_id'),
 // The time of the last account check of an Entra account (lib/server/identity/entra/directory-check.ts).
 entra_checked_at:bigint('entra_checked_at',{mode:'number'}),
 // Since when the account check keeps this account active although Entra reports it disabled or deleted,
 // because it holds the last Owner assignment; NULL while that is not the case (docs/entra-id.md, "The last Owner").
 entra_kept_owner_since:bigint('entra_kept_owner_since',{mode:'number'})
},t=>[
 check('local_users_status',sql`status IN ('active','invited','disabled')`),
 check('local_users_identity_source',sql`identity_source IN ('local','entra')`),
 check('local_users_entra_identity',sql`(identity_source = 'local' AND entra_tenant_id IS NULL AND entra_object_id IS NULL) OR (identity_source = 'entra' AND entra_tenant_id IS NOT NULL AND entra_object_id IS NOT NULL AND password_hash IS NULL AND must_reset = 0 AND auth_principal = 'entra:' || entra_tenant_id || ':' || entra_object_id)`),
 uniqueIndex('local_users_entra').on(t.entra_tenant_id,t.entra_object_id),
 uniqueIndex('local_users_auth_email').on(t.auth_email),
 uniqueIndex('local_users_principal').on(t.auth_principal),
 uniqueIndex('local_users_username').on(t.username)
]);
// The lease of the one active maintenance run across every portal instance
// (runtime/maintenance.mjs). One row; holder and expires_at are set together.
export const maintenanceLock=pgTable('maintenance_lock',{
 id:smallint('id').primaryKey().notNull(),
 holder:text('holder'),
 run_id:bigint('run_id',{mode:'number'}),
 acquired_at:bigint('acquired_at',{mode:'number'}),
 expires_at:bigint('expires_at',{mode:'number'})
},()=>[
 check('maintenance_lock_single_row',sql`id = 1`),
 check('maintenance_lock_holder',sql`(holder IS NULL) = (expires_at IS NULL)`)
]);
export const maintenanceRuns=pgTable('maintenance_runs',{
 id:bigint('id',{mode:'number'}).primaryKey().generatedByDefaultAsIdentity(),
 started_at:bigint('started_at',{mode:'number'}).notNull(),
 finished_at:bigint('finished_at',{mode:'number'}),
 status:text('status').notNull(),
 result:text('result'),
 error:text('error'),
 trigger:text('trigger').notNull().default('cli'),
 requested_by:text('requested_by')
},t=>[
 check('maintenance_runs_status',sql`status IN ('running','succeeded','failed')`),
 check('maintenance_runs_result',sql`result IS NULL OR result IS JSON`),
 check('maintenance_runs_error',sql`length(error) <= 500`),
 check('maintenance_runs_finished',sql`(status = 'running') = (finished_at IS NULL)`),
 check('maintenance_runs_trigger',sql`trigger IN ('schedule','continuation','manual','cli')`),
 index('maintenance_runs_finished').on(t.status,t.finished_at)
]);
// The instance maintenance settings of the page Settings → Maintenance. A NULL
// retention means: the environment start value, else 30 days.
export const maintenanceSettings=pgTable('maintenance_settings',{
 id:smallint('id').primaryKey().notNull(),
 audit_days:integer('audit_days'),
 job_days:integer('job_days'),
 run_at:smallint('run_at').notNull().default(180),
 time_zone:text('time_zone').notNull().default('UTC'),
 revision:bigint('revision',{mode:'number'}).notNull().default(0),
 updated_at:bigint('updated_at',{mode:'number'}),
 updated_by:text('updated_by')
},()=>[
 check('maintenance_settings_single_row',sql`id = 1`),
 check('maintenance_settings_audit_days',sql`audit_days BETWEEN 1 AND 3650`),
 check('maintenance_settings_job_days',sql`job_days BETWEEN 1 AND 3650`),
 check('maintenance_settings_run_at',sql`run_at BETWEEN 0 AND 1439`),
 check('maintenance_settings_time_zone',sql`length(time_zone) BETWEEN 1 AND 64`),
 check('maintenance_settings_revision',sql`revision >= 0`)
]);
export const mfaAccounts=pgTable('mfa_accounts',{
 principal:text('principal').primaryKey().notNull(),
 secret_enc:text('secret_enc').notNull(),
 recovery_hashes:text('recovery_hashes').notNull(),
 last_counter:bigint('last_counter',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 authenticators_migrated:bigint('authenticators_migrated',{mode:'number'}).notNull().default(0)
});
export const mfaAttempts=pgTable('mfa_attempts',{
 principal:text('principal').primaryKey().notNull(),
 attempts:bigint('attempts',{mode:'number'}).notNull(),
 window_at:bigint('window_at',{mode:'number'}).notNull(),
 blocked_until:bigint('blocked_until',{mode:'number'}).notNull().default(0)
});
export const mfaAuthenticatorChallenges=pgTable('mfa_authenticator_challenges',{
 id:text('id').primaryKey().notNull(),
 principal:text('principal').notNull(),
 session_hash:text('session_hash').notNull(),
 authenticator_id:text('authenticator_id'),
 previous_secret_enc:text('previous_secret_enc'),
 name:text('name').notNull(),
 secret_enc:text('secret_enc').notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull()
},t=>[
 index('idx_mfa_authenticator_challenges_expiry').on(t.expires_at),
 index('idx_mfa_authenticator_challenges_principal').on(t.principal)
]);
export const mfaAuthenticators=pgTable('mfa_authenticators',{
 id:text('id').primaryKey().notNull(),
 principal:text('principal').notNull(),
 name:text('name').notNull(),
 secret_enc:text('secret_enc').notNull(),
 last_counter:bigint('last_counter',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 last_used_at:bigint('last_used_at',{mode:'number'})
},t=>[
 index('idx_mfa_authenticators_principal').on(t.principal)
]);
// The MFA grant (docs/portal-sessions.md, "What each sign-in asks for"): the
// account `principal` completed MFA at sign-in in the browser that holds the
// cookie __Host-serverdesk-mfa-grant. Only the SHA-256 of its random token is
// stored. Until `expires_at` (created_at + MFA_GRANT_LIFETIME_MS,
// lib/server/identity/session-settings.ts) the next sign-in of that account in
// that browser asks only for the first factor.
export const mfaGrants=pgTable('mfa_grants',{
 token_hash:text('token_hash').primaryKey().notNull(),
 principal:text('principal').notNull(),
 user_id:text('user_id').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull()
},t=>[
 index('idx_mfa_grants_expiry').on(t.expires_at),
 index('idx_mfa_grants_principal').on(t.principal),
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}).onDelete('cascade')
]);
export const mfaChallenges=pgTable('mfa_challenges',{
 principal:text('principal').primaryKey().notNull(),
 secret_enc:text('secret_enc').notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull()
});
export const mfaManagementProofs=pgTable('mfa_management_proofs',{
 token_hash:text('token_hash').primaryKey().notNull(),
 principal:text('principal').notNull(),
 session_hash:text('session_hash').notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull()
},t=>[
 index('idx_mfa_management_proofs_expiry').on(t.expires_at),
 index('idx_mfa_management_proofs_principal').on(t.principal)
]);
export const mfaProofs=pgTable('mfa_proofs',{
 token_hash:text('token_hash').primaryKey().notNull(),
 principal:text('principal').notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull()
},t=>[
 index('idx_mfa_proofs_principal').on(t.principal)
]);
export const mfaSessions=pgTable('mfa_sessions',{
 token_hash:text('token_hash').primaryKey().notNull(),
 principal:text('principal').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 last_activity:bigint('last_activity',{mode:'number'}).notNull(),
 idle_expires_at:bigint('idle_expires_at',{mode:'number'}).notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull(),
 passkey_id:text('passkey_id')
},t=>[
 index('idx_mfa_sessions_expiry').on(t.idle_expires_at,t.expires_at),
 index('idx_mfa_sessions_principal').on(t.principal)
]);
// AD sign-ins for plugin changes (lib/server/extensions/plugin-ad-sessions.ts, docs/plugin-ad-sign-in.md):
// one row per portal (MFA) session and directory. A pending row waits for its
// ad-sign-in job; an active row holds the verified identity, never a password.
// Ending the portal session deletes its rows through the foreign key.
export const pluginAdSessions=pgTable('plugin_ad_sessions',{
 id:text('id').primaryKey().notNull(),
 principal:text('principal').notNull(),
 session_hash:text('session_hash').notNull(),
 state:text('state').notNull(),
 source:text('source').notNull(),
 job_id:text('job_id'),
 server_id:text('server_id'),
 directory_kind:text('directory_kind').notNull(),
 directory_name:text('directory_name').notNull(),
 directory_sid:text('directory_sid').notNull(),
 user_sid:text('user_sid'),
 account:text('account'),
 upn:text('upn'),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 verified_at:bigint('verified_at',{mode:'number'}),
 expires_at:bigint('expires_at',{mode:'number'})
},t=>[
 foreignKey({columns:[t.session_hash],foreignColumns:[mfaSessions.token_hash]}).onDelete('cascade'),
 uniqueIndex('idx_plugin_ad_sessions_active').on(t.session_hash,t.directory_sid).where(sql`state = 'active'`),
 index('idx_plugin_ad_sessions_job').on(t.job_id),
 check('plugin_ad_sessions_state_check',sql`state IN ('pending','active')`),
 check('plugin_ad_sessions_source_check',sql`source IN ('password','entra')`),
 check('plugin_ad_sessions_directory_kind_check',sql`directory_kind IN ('domain','local')`),
 check('plugin_ad_sessions_active_check',sql`state <> 'active' OR (user_sid IS NOT NULL AND verified_at IS NOT NULL)`)
]);
// Notification channels (lib/server/notifications/notification-channels.ts): email over SMTP,
// Microsoft Teams and a signed webhook. config holds the settings that are not
// secret; secret holds the keyring ciphertext (context notification-channel:<id>)
// of the password, the URL and the HMAC key. target_hint is the masked target.
export const notificationChannels=pgTable('notification_channels',{
 id:text('id').primaryKey().notNull(),
 type:text('type').notNull(),
 name:text('name').notNull(),
 enabled:smallint('enabled').notNull(),
 language:text('language').default('en').notNull(),
 config:text('config').notNull(),
 secret:text('secret'),
 target_hint:text('target_hint').notNull(),
 revision:bigint('revision',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 updated_by:text('updated_by').notNull()
},t=>[
 check('notification_channels_type_check',sql`type IN ('smtp','teams','discord','webhook')`),
 check('notification_channels_name_check',sql`length(name) BETWEEN 1 AND 80`),
 check('notification_channels_enabled_check',sql`enabled IN (0,1)`),
 check('notification_channels_language_check',sql`language IN ('en','de')`),
 check('notification_channels_config_check',sql`config IS JSON OBJECT`),
 check('notification_channels_revision_check',sql`revision >= 0`),
 uniqueIndex('idx_notification_channels_name').on(sql`lower(${t.name})`)
]);
// The lease of the notification dispatcher (lib/server/notifications/notifications.ts,
// runNotificationDispatch): one row, like alert_sweep.
export const notificationDispatch=pgTable('notification_dispatch',{
 id:smallint('id').primaryKey().notNull(),
 last_started_at:bigint('last_started_at',{mode:'number'})
},()=>[
 check('notification_dispatch_single_row',sql`id = 1`)
]);
// A security alarm of the portal itself, not of a device: an emergency sign-in
// while Microsoft sign-in only is on (docs/entra-id.md). Written in the batch of
// the sign-in; open until another Owner acknowledges it. actor and display_name
// keep the account as it was at the sign-in.
export const securityAlarms=pgTable('security_alarms',{
 id:text('id').primaryKey().notNull(),
 kind:text('kind').notNull(),
 user_id:text('user_id').notNull(),
 actor:text('actor').notNull(),
 display_name:text('display_name').notNull(),
 address:text('address').notNull(),
 occurred_at:bigint('occurred_at',{mode:'number'}).notNull(),
 acknowledged_at:bigint('acknowledged_at',{mode:'number'}),
 acknowledged_by:text('acknowledged_by')
},t=>[
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}),
 check('security_alarms_kind',sql`kind IN ('emergencySignIn')`),
 check('security_alarms_acknowledged',sql`(acknowledged_at IS NULL) = (acknowledged_by IS NULL)`),
 index('idx_security_alarms_open').on(t.occurred_at).where(sql`acknowledged_at IS NULL`)
]);
// One row per alarm transition that can notify (open, escalate, close) and per
// test message. Written in the transaction of the alarm change; the dispatcher
// routes it once (routed or suppressed). alert_id has no foreign key: the alarm
// may be pruned while the log keeps the event.
export const notificationEvents=pgTable('notification_events',{
 id:text('id').primaryKey().notNull(),
 alert_id:text('alert_id'),
 server_id:text('server_id'),
 customer_id:text('customer_id'),
 kind:text('kind').notNull(),
 level:text('level'),
 rule_id:text('rule_id'),
 key:text('key'),
 value:doublePrecision('value'),
 threshold:integer('threshold'),
 close_reason:text('close_reason'),
 occurred_at:bigint('occurred_at',{mode:'number'}).notNull(),
 status:text('status').notNull(),
 suppressed_reason:text('suppressed_reason'),
 routed_at:bigint('routed_at',{mode:'number'}),
 // kind='emergency': the emergency sign-in this event notifies about (lib/server/notifications/notifications.ts).
 security_alarm_id:text('security_alarm_id')
},t=>[
 check('notification_events_kind_check',sql`kind IN ('open','escalate','close','test','emergency')`),
 check('notification_events_level_check',sql`level IS NULL OR level IN ('info','warning','critical')`),
 check('notification_events_alarm_check',sql`(kind IN ('test','emergency')) = (alert_id IS NULL) AND (kind IN ('test','emergency')) = (server_id IS NULL) AND (kind = 'test') = (level IS NULL) AND (kind <> 'emergency' OR level = 'critical')`),
 check('notification_events_emergency_check',sql`(kind = 'emergency') = (security_alarm_id IS NOT NULL)`),
 foreignKey({columns:[t.security_alarm_id],foreignColumns:[securityAlarms.id]}),
 uniqueIndex('idx_notification_events_security_alarm').on(t.security_alarm_id),
 check('notification_events_close_reason_check',sql`(kind = 'close') = (close_reason IS NOT NULL) AND (close_reason IS NULL OR close_reason IN ('recovered','rule-off','no-data'))`),
 check('notification_events_status_check',sql`status IN ('pending','routed','suppressed')`),
 check('notification_events_suppressed_check',sql`(status = 'suppressed') = (suppressed_reason IS NOT NULL) AND (suppressed_reason IS NULL OR suppressed_reason IN ('muted','maintenance-window','not-notified','no-rule','no-recipient'))`),
 uniqueIndex('idx_notification_events_open').on(t.alert_id).where(sql`kind = 'open'`),
 uniqueIndex('idx_notification_events_close').on(t.alert_id).where(sql`kind = 'close'`),
 index('idx_notification_events_alert').on(t.alert_id),
 index('idx_notification_events_pending').on(t.occurred_at).where(sql`status = 'pending'`),
 index('idx_notification_events_occurred').on(t.occurred_at,t.id)
]);
// The deliveries of a routed event, one per channel. channel_name, channel_type
// and target_hint are copied at routing, so the log keeps them after the channel
// is deleted. A run claims a row (pending -> sending with its run ID) before it
// sends; claimed_at finds rows of a crashed process.
export const notificationDeliveries=pgTable('notification_deliveries',{
 id:text('id').primaryKey().notNull(),
 event_id:text('event_id').notNull(),
 channel_id:text('channel_id'),
 channel_name:text('channel_name').notNull(),
 channel_type:text('channel_type').notNull(),
 target_hint:text('target_hint').notNull(),
 message_id:text('message_id'),
 status:text('status').notNull(),
 attempts:integer('attempts').notNull(),
 next_attempt_at:bigint('next_attempt_at',{mode:'number'}),
 sent_at:bigint('sent_at',{mode:'number'}),
 last_attempt_at:bigint('last_attempt_at',{mode:'number'}),
 error_key:text('error_key'),
 error_params:text('error_params'),
 claimed_by:text('claimed_by'),
 claimed_at:bigint('claimed_at',{mode:'number'}),
 recovered:smallint('recovered').default(0).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 // The email addresses of an emergency delivery, fixed at routing (a JSON array); NULL otherwise.
 recipients:text('recipients')
},t=>[
 foreignKey({columns:[t.event_id],foreignColumns:[notificationEvents.id]}).onDelete('cascade'),
 check('notification_deliveries_recipients_check',sql`recipients IS NULL OR recipients IS JSON ARRAY`),
 foreignKey({columns:[t.channel_id],foreignColumns:[notificationChannels.id]}).onDelete('set null'),
 check('notification_deliveries_type_check',sql`channel_type IN ('smtp','teams','discord','webhook')`),
 check('notification_deliveries_status_check',sql`status IN ('pending','sending','sent','failed')`),
 check('notification_deliveries_sending_check',sql`(status = 'sending') = (claimed_by IS NOT NULL)`),
 check('notification_deliveries_sent_check',sql`(status = 'sent') = (sent_at IS NOT NULL)`),
 check('notification_deliveries_attempts_check',sql`attempts BETWEEN 0 AND 10 AND recovered IN (0,1)`),
 check('notification_deliveries_error_params_check',sql`error_params IS NULL OR error_params IS JSON OBJECT`),
 uniqueIndex('idx_notification_deliveries_event_channel').on(t.event_id,t.channel_id),
 index('idx_notification_deliveries_due').on(t.channel_id,t.next_attempt_at).where(sql`status = 'pending'`),
 index('idx_notification_deliveries_sending').on(t.claimed_at).where(sql`status = 'sending'`),
 index('idx_notification_deliveries_channel').on(t.channel_id,t.last_attempt_at)
]);
// Notification rules (lib/server/notifications/notification-rules.ts): which levels and events of the
// alarms of a scope go to a channel. scope_id is '*' for All devices, else a
// device group or customer ID; triggers delete the rules of a deleted group or
// customer. levels is a canonical JSON array of the chosen levels.
export const notificationRules=pgTable('notification_rules',{
 id:text('id').primaryKey().notNull(),
 scope_type:text('scope_type').notNull(),
 scope_id:text('scope_id').notNull(),
 channel_id:text('channel_id').notNull(),
 levels:text('levels').notNull(),
 on_open:smallint('on_open').notNull(),
 on_close:smallint('on_close').notNull(),
 on_escalate:smallint('on_escalate').notNull(),
 enabled:smallint('enabled').notNull(),
 revision:bigint('revision',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 updated_by:text('updated_by').notNull()
},t=>[
 foreignKey({columns:[t.channel_id],foreignColumns:[notificationChannels.id]}).onDelete('cascade'),
 check('notification_rules_scope_type_check',sql`scope_type IN ('all','customer','group')`),
 check('notification_rules_scope_id_check',sql`(scope_type = 'all') = (scope_id = '*')`),
 check('notification_rules_levels_check',sql`levels IN ('["info"]','["warning"]','["critical"]','["info","warning"]','["info","critical"]','["warning","critical"]','["info","warning","critical"]')`),
 check('notification_rules_flags_check',sql`on_open IN (0,1) AND on_close IN (0,1) AND on_escalate IN (0,1) AND enabled IN (0,1) AND on_open + on_close + on_escalate >= 1`),
 check('notification_rules_revision_check',sql`revision >= 0`),
 unique('notification_rules_scope_channel_key').on(t.scope_type,t.scope_id,t.channel_id),
 index('idx_notification_rules_channel').on(t.channel_id)
]);
// The rate limit of "Send test message" (lib/server/notifications/notification-channels.ts): one row
// per principal with the attempts of its fixed 60-second window.
export const notificationTestLimits=pgTable('notification_test_limits',{
 principal:text('principal').primaryKey().notNull(),
 attempts:integer('attempts').notNull(),
 window_at:bigint('window_at',{mode:'number'}).notNull()
});
// The Extended Security Updates date (lib/server/devices/os-esu.ts) of a group or device: the
// support end of its operating system moves to this date when it is later.
// scope_id is polymorphic; triggers remove the row with its group or device.
export const osEsuOverrides=pgTable('os_esu_overrides',{
 id:text('id').primaryKey().notNull(),
 scope_type:text('scope_type').notNull(),
 scope_id:text('scope_id').notNull(),
 until:text('until').notNull(),
 actor:text('actor').notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull()
},t=>[
 check('os_esu_overrides_scope_type_check',sql`scope_type IN ('customer','group','device')`),
 check('os_esu_overrides_until_check',sql`until ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
 unique('os_esu_overrides_scope_type_scope_id_key').on(t.scope_type,t.scope_id)
]);
export const passkeyChallenges=pgTable('passkey_challenges',{
 id:text('id').primaryKey().notNull(),
 principal:text('principal').notNull(),
 purpose:text('purpose').notNull(),
 challenge:text('challenge').notNull(),
 browser_hash:text('browser_hash').notNull(),
 session_hash:text('session_hash'),
 rp_id:text('rp_id').notNull(),
 origin:text('origin').notNull(),
 name:text('name').notNull(),
 device:text('device').notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull()
},t=>[
 index('idx_passkey_challenges_expiry').on(t.expires_at),
 index('idx_passkey_challenges_principal').on(t.principal)
]);
export const passkeyCredentials=pgTable('passkey_credentials',{
 id:text('id').primaryKey().notNull(),
 principal:text('principal').notNull(),
 public_key:text('public_key').notNull(),
 counter:bigint('counter',{mode:'number'}).notNull(),
 transports:text('transports').notNull(),
 name:text('name').notNull(),
 device:text('device').notNull(),
 device_type:text('device_type').notNull(),
 backed_up:bigint('backed_up',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 last_used_at:bigint('last_used_at',{mode:'number'})
},t=>[
 index('idx_passkey_credentials_principal').on(t.principal)
]);
export const passkeyRateLimits=pgTable('passkey_rate_limits',{
 principal:text('principal').primaryKey().notNull(),
 attempts:bigint('attempts',{mode:'number'}).notNull(),
 window_at:bigint('window_at',{mode:'number'}).notNull()
});
export const rbacRoles=pgTable('rbac_roles',{
 id:text('id').primaryKey().notNull(),
 name:text('name').notNull(),
 description:text('description').notNull().default(''),
 permissions:text('permissions').notNull(),
 builtin:bigint('builtin',{mode:'number'}).notNull().default(0),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 customer_id:text('customer_id')
},t=>[
 check('rbac_roles_permissions',sql`permissions IS JSON`),
 index('idx_rbac_roles_customer').on(t.customer_id),
 uniqueIndex('rbac_roles_name').on(t.name)
]);
export const rdpFrames=pgTable('rdp_frames',{
 session_id:text('session_id').notNull(),
 direction:text('direction').notNull(),
 seq:bigint('seq',{mode:'number'}).notNull(),
 data:text('data').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull()
},t=>[
 primaryKey({columns:[t.session_id,t.direction,t.seq]}),
 foreignKey({columns:[t.session_id],foreignColumns:[rdpSessions.id]}).onDelete('cascade'),
 check('rdp_frame_direction',sql`direction IN ('in','out')`),
 check('rdp_frame_seq',sql`seq>0`)
]);
export const rdpReceipts=pgTable('rdp_receipts',{
 session_id:text('session_id').notNull(),
 direction:text('direction').notNull(),
 seq:bigint('seq',{mode:'number'}).notNull(),
 digest:text('digest').notNull()
},t=>[
 primaryKey({columns:[t.session_id,t.direction,t.seq]}),
 foreignKey({columns:[t.session_id],foreignColumns:[rdpSessions.id]}).onDelete('cascade'),
 check('rdp_receipt_direction',sql`direction IN ('in','out')`),
 check('rdp_receipt_seq',sql`seq>0`)
]);
export const rdpRtcSessions=pgTable('rdp_rtc_sessions',{
 session_id:text('session_id').primaryKey().notNull(),
 offer:text('offer').notNull(),
 answer:text('answer')
},t=>[
 foreignKey({columns:[t.session_id],foreignColumns:[rdpSessions.id]}).onDelete('cascade'),
 check('rdp_rtc_offer_size',sql`length(offer) BETWEEN 24 AND 65536`),
 check('rdp_rtc_answer_size',sql`answer IS NULL OR length(answer) BETWEEN 24 AND 65536`)
]);
export const rdpSessions=pgTable('rdp_sessions',{
 id:text('id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 principal:text('principal').notNull(),
 mfa_hash:text('mfa_hash').notNull(),
 state:text('state').notNull().default('opening'),
 key_envelope:text('key_envelope'),
 key_hash:text('key_hash').notNull(),
 input_seq:bigint('input_seq',{mode:'number'}).notNull().default(0),
 input_ack:bigint('input_ack',{mode:'number'}).notNull().default(0),
 output_seq:bigint('output_seq',{mode:'number'}).notNull().default(0),
 output_ack:bigint('output_ack',{mode:'number'}).notNull().default(0),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 last_presence:bigint('last_presence',{mode:'number'}).notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull(),
 error:text('error'),
 transport:text('transport').notNull().default('mailbox')
},t=>[
 foreignKey({columns:[t.server_id],foreignColumns:[servers.id]}),
 check('rdp_session_state',sql`state IN ('opening','open','closed','error')`),
 check('rdp_session_ack',sql`input_ack>=0 AND input_ack<=input_seq AND output_ack>=0 AND output_ack<=output_seq`),
 index('rdp_sessions_device_state').on(t.server_id,t.state)
]);
export const roleAssignments=pgTable('role_assignments',{
 id:text('id').primaryKey().notNull(),
 principal_type:text('principal_type').notNull(),
 principal_id:text('principal_id').notNull(),
 role_id:text('role_id').notNull(),
 scope_type:text('scope_type').notNull(),
 scope_id:text('scope_id').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull(),
 // 'entra': written and removed only by the Entra role sync (lib/server/identity/entra/role-sync.ts).
 source:text('source').notNull().default('manual')
},t=>[
 foreignKey({columns:[t.role_id],foreignColumns:[rbacRoles.id]}),
 check('role_assignment_principal_type',sql`principal_type IN ('user','group')`),
 check('role_assignment_source',sql`source IN ('manual','entra')`),
 check('role_assignment_entra_user',sql`source = 'manual' OR (principal_type = 'user' AND scope_type IN ('global','devicegroup'))`),
 check('role_assignment_scope_type',sql`scope_type IN ('global','devicegroup','device')`),
 check('role_assignment_global',sql`scope_type<>'global' OR scope_id='*'`),
 index('role_assignments_subject').on(t.principal_type,t.principal_id),
 uniqueIndex('role_assignments_unique').on(t.principal_type,t.principal_id,t.role_id,t.scope_type,t.scope_id)
]);
export const runbookRunDevices=pgTable('runbook_run_devices',{
 run_id:text('run_id').notNull(),
 server_id:text('server_id').notNull(),
 state:text('state').notNull().default('queued'),
 step_index:bigint('step_index',{mode:'number'}).notNull().default(0),
 job_id:text('job_id'),
 sealed_secrets:text('sealed_secrets').notNull().default('{}'),
 result:text('result'),
 started_at:bigint('started_at',{mode:'number'}),
 finished_at:bigint('finished_at',{mode:'number'}),
 result_code:text('result_code'),
 result_args:text('result_args')
},t=>[
 index('idx_runbook_devices_server_state').on(t.server_id,t.state),
 uniqueIndex('idx_runbook_run_devices_run_id_server_id').on(t.run_id,t.server_id)
]);
export const runbookRuns=pgTable('runbook_runs',{
 id:text('id').primaryKey().notNull(),
 version_id:text('version_id').notNull(),
 schedule_id:text('schedule_id'),
 due_key:text('due_key'),
 actor:text('actor').notNull(),
 state:text('state').notNull().default('queued'),
 parameters:text('parameters').notNull(),
 concurrency:bigint('concurrency',{mode:'number'}).notNull(),
 failure_stop:bigint('failure_stop',{mode:'number'}).notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull(),
 finished_at:bigint('finished_at',{mode:'number'}),
 cancel_requested:bigint('cancel_requested',{mode:'number'}).notNull().default(0)
},t=>[
 uniqueIndex('runbook_runs_due_key_unique').on(t.due_key)
]);
export const runbookSchedules=pgTable('runbook_schedules',{
 id:text('id').primaryKey().notNull(),
 version_id:text('version_id').notNull(),
 actor:text('actor').notNull(),
 targets:text('targets').notNull(),
 parameters:text('parameters').notNull(),
 sealed_secrets:text('sealed_secrets').notNull().default('{}'),
 recurrence:text('recurrence').notNull(),
 next_due:bigint('next_due',{mode:'number'}).notNull(),
 catchup_seconds:bigint('catchup_seconds',{mode:'number'}).notNull(),
 concurrency:bigint('concurrency',{mode:'number'}).notNull(),
 failure_stop:bigint('failure_stop',{mode:'number'}).notNull(),
 enabled:bigint('enabled',{mode:'number'}).notNull().default(1),
 approved_at:bigint('approved_at',{mode:'number'}).notNull(),
 last_due:bigint('last_due',{mode:'number'}),
 created_at:bigint('created_at',{mode:'number'}).notNull()
},t=>[
 index('idx_runbook_schedules_due').on(t.enabled,t.next_due)
]);
export const runbookStepResults=pgTable('runbook_step_results',{
 run_id:text('run_id').notNull(),
 server_id:text('server_id').notNull(),
 step_index:bigint('step_index',{mode:'number'}).notNull(),
 job_id:text('job_id').notNull(),
 state:text('state').notNull().default('pending'),
 result:text('result'),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 completed_at:bigint('completed_at',{mode:'number'}),
 result_code:text('result_code'),
 result_args:text('result_args')
},t=>[
 uniqueIndex('idx_runbook_step_job').on(t.job_id),
 uniqueIndex('idx_runbook_step_results_run_id_server_id_step_index').on(t.run_id,t.server_id,t.step_index)
]);
export const runbookVersions=pgTable('runbook_versions',{
 id:text('id').primaryKey().notNull(),
 runbook_id:text('runbook_id').notNull(),
 version:bigint('version',{mode:'number'}).notNull(),
 definition:text('definition').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull()
},t=>[
 uniqueIndex('idx_runbook_versions_runbook_id_version').on(t.runbook_id,t.version)
]);
export const runbooks=pgTable('runbooks',{
 id:text('id').primaryKey().notNull(),
 name:text('name').notNull(),
 description:text('description').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 created_by:text('created_by').notNull(),
 archived:bigint('archived',{mode:'number'}).notNull().default(0),
 customer_id:text('customer_id')
},t=>[
 index('idx_runbooks_customer').on(t.customer_id)
]);
export const samples=pgTable('samples',{
 id:bigint('id',{mode:'number'}).primaryKey().generatedByDefaultAsIdentity(),
 server_id:text('server_id').notNull(),
 at:bigint('at',{mode:'number'}).notNull(),
 cpu:bigint('cpu',{mode:'number'}),
 memory:bigint('memory',{mode:'number'}),
 gpus:text('gpus')
},t=>[
 check('samples_gpus',sql`gpus IS NULL OR (length(gpus)<=65536 AND CASE WHEN gpus IS JSON ARRAY THEN jsonb_array_length(gpus::jsonb)<=16 ELSE false END)`),
 index('idx_samples_server_at').on(t.server_id,t.at)
]);
export const servers=pgTable('servers',{
 id:text('id').primaryKey().notNull(),
 name:text('name').notNull(),
 token_hash:text('token_hash').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 last_seen:bigint('last_seen',{mode:'number'}),
 snapshot:text('snapshot'),
 revoked:bigint('revoked',{mode:'number'}).notNull().default(0),
 management:bigint('management',{mode:'number'}).notNull().default(0),
 agent_public_key:text('agent_public_key'),
 token_expires_at:bigint('token_expires_at',{mode:'number'}),
 previous_token_hash:text('previous_token_hash'),
 previous_token_expires_at:bigint('previous_token_expires_at',{mode:'number'}),
 token_rotated_at:bigint('token_rotated_at',{mode:'number'}),
 customer_id:text('customer_id').notNull().default(defaultCustomerId),
 // Free text of the portal (lib/device-description.ts); no agent path writes it.
 description:text('description').notNull().default(''),
 // Where name comes from (lib/device-name.ts): hostname follows the computer
 // name of every heartbeat, custom stays, pending waits for the first heartbeat.
 name_source:text('name_source').notNull().default('hostname')
},t=>[
 index('idx_servers_customer').on(t.customer_id),
 check('servers_name_source_check',sql`name_source IN ('hostname','custom','pending')`)
]);
// Name-value tags of devices and device groups (lib/tags.ts, lib/server/devices/tag-store.ts).
// scope_id is polymorphic: hand-written triggers in 0003 delete the tags of a
// removed device or a deleted group. Only group tags can be inherited.
export const tags=pgTable('tags',{
 id:text('id').primaryKey().notNull(),
 scope_type:text('scope_type').notNull(),
 scope_id:text('scope_id').notNull(),
 name:text('name').notNull(),
 value:text('value').notNull().default(''),
 inherit:smallint('inherit').notNull().default(0),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 updated_by:text('updated_by').notNull(),
 // tagKey(name) of lib/tags.ts, the one case rule of tag names: every write
 // sets it with the name, and SQL compares only this column (0011).
 name_key:text('name_key').notNull()
},t=>[
 check('tags_scope_type_check',sql`scope_type IN ('device','group')`),
 check('tags_name_length_check',sql`char_length(name) BETWEEN 1 AND 64`),
 check('tags_name_trim_check',sql`name=btrim(name)`),
 check('tags_value_check',sql`char_length(value)<=256`),
 check('tags_inherit_check',sql`inherit IN (0,1)`),
 check('tags_inherit_scope_check',sql`scope_type='group' OR inherit=0`),
 check('tags_name_key_check',sql`name_key<>''`),
 uniqueIndex('idx_tags_scope_name').on(t.scope_type,t.scope_id,t.name_key),
 index('idx_tags_name_value').on(t.name_key,t.value)
]);
export const terminalFrames=pgTable('terminal_frames',{
 id:text('id').primaryKey().notNull(),
 session_id:text('session_id').notNull(),
 direction:text('direction').notNull(),
 seq:bigint('seq',{mode:'number'}).notNull(),
 data:text('data').notNull(),
 created_at:bigint('created_at',{mode:'number'}).notNull()
},t=>[
 uniqueIndex('idx_terminal_frame_seq').on(t.session_id,t.direction,t.seq)
]);
export const terminalSessions=pgTable('terminal_sessions',{
 id:text('id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 principal:text('principal').notNull(),
 state:text('state').notNull(),
 cols:bigint('cols',{mode:'number'}).notNull(),
 rows:bigint('rows',{mode:'number'}).notNull(),
 input_seq:bigint('input_seq',{mode:'number'}).notNull().default(0),
 input_ack:bigint('input_ack',{mode:'number'}).notNull().default(0),
 output_seq:bigint('output_seq',{mode:'number'}).notNull().default(0),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 last_activity:bigint('last_activity',{mode:'number'}).notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull(),
 error:text('error'),
 mfa_hash:text('mfa_hash')
},t=>[
 index('idx_terminal_device').on(t.server_id,t.state)
]);
export const transferChunks=pgTable('transfer_chunks',{
 id:text('id').primaryKey().notNull(),
 transfer_id:text('transfer_id').notNull(),
 chunk:bigint('chunk',{mode:'number'}).notNull(),
 size:bigint('size',{mode:'number'}).notNull(),
 sha256:text('sha256').notNull()
},t=>[
 uniqueIndex('idx_transfer_chunk').on(t.transfer_id,t.chunk)
]);
export const transfers=pgTable('transfers',{
 id:text('id').primaryKey().notNull(),
 server_id:text('server_id').notNull(),
 principal:text('principal').notNull(),
 direction:text('direction').notNull(),
 path:text('path').notNull(),
 size:bigint('size',{mode:'number'}),
 state:text('state').notNull(),
 overwrite:bigint('overwrite',{mode:'number'}).notNull().default(0),
 created_at:bigint('created_at',{mode:'number'}).notNull(),
 updated_at:bigint('updated_at',{mode:'number'}).notNull(),
 expires_at:bigint('expires_at',{mode:'number'}).notNull(),
 message:text('message'),
 sha256:text('sha256')
},t=>[
 index('idx_transfer_device').on(t.server_id,t.state),
 index('idx_transfers_state_expiry').on(t.state,t.expires_at)
]);
export const usageData=pgTable('usage_data',{
 id:bigint('id',{mode:'number'}).primaryKey().notNull(),
 instance_id:text('instance_id').notNull(),
 consent:bigint('consent',{mode:'number'}),
 decided_at:bigint('decided_at',{mode:'number'}),
 decided_by:text('decided_by'),
 last_attempt_at:bigint('last_attempt_at',{mode:'number'}),
 last_success_at:bigint('last_success_at',{mode:'number'}),
 last_error:text('last_error'),
 revision:bigint('revision',{mode:'number'}).notNull().default(0)
},()=>[
 check('usage_data_single_row',sql`id = 1`),
 check('usage_data_instance_id',sql`length(instance_id) = 32 AND instance_id ~ '^[0-9a-f]*$'`),
 check('usage_data_consent',sql`consent IN (0,1)`),
 check('usage_data_last_error',sql`length(last_error) <= 40`)
]);
export const userGroupMembers=pgTable('user_group_members',{
 group_id:text('group_id').notNull(),
 user_id:text('user_id').notNull()
},t=>[
 primaryKey({columns:[t.group_id,t.user_id]}),
 foreignKey({columns:[t.group_id],foreignColumns:[userGroups.id]}).onDelete('cascade'),
 foreignKey({columns:[t.user_id],foreignColumns:[localUsers.id]}).onDelete('cascade'),
 index('user_group_members_user').on(t.user_id)
]);
export const userGroups=pgTable('user_groups',{
 id:text('id').primaryKey().notNull(),
 name:text('name').notNull(),
 description:text('description').notNull().default(''),
 enabled:bigint('enabled',{mode:'number'}).notNull().default(1),
 created_at:bigint('created_at',{mode:'number'}).notNull()
},t=>[
 uniqueIndex('user_groups_name').on(t.name)
]);
// The vulnerability check of the software inventory (lib/server/devices/vulnerabilities.ts,
// lib/server/devices/vulnerability-sync.ts). One settings row; api_key is keyring ciphertext.
export const vulnerabilitySettings=pgTable('vulnerability_settings',{
 id:smallint('id').primaryKey().notNull(),
 enabled:smallint('enabled').notNull().default(0),
 api_key:text('api_key'),
 revision:bigint('revision',{mode:'number'}).notNull().default(0),
 updated_at:bigint('updated_at',{mode:'number'}),
 updated_by:text('updated_by'),
 // The optional second source: CVE.org records through CIRCL Vulnerability-Lookup.
 cvelist_enabled:smallint('cvelist_enabled').notNull().default(0)
},()=>[
 check('vulnerability_settings_single_row',sql`id = 1`),
 check('vulnerability_settings_enabled_check',sql`enabled IN (0,1)`),
 check('vulnerability_settings_cvelist_enabled_check',sql`cvelist_enabled IN (0,1)`),
 check('vulnerability_settings_revision_check',sql`revision >= 0`)
]);
// The lease and state of the NVD sync: one row, like alert_sweep.
export const vulnerabilitySync=pgTable('vulnerability_sync',{
 id:smallint('id').primaryKey().notNull(),
 lease_holder:text('lease_holder'),
 lease_until:bigint('lease_until',{mode:'number'}),
 requested_at:bigint('requested_at',{mode:'number'}),
 last_started_at:bigint('last_started_at',{mode:'number'}),
 last_finished_at:bigint('last_finished_at',{mode:'number'}),
 last_success_at:bigint('last_success_at',{mode:'number'}),
 last_status:text('last_status'),
 last_error:text('last_error'),
 // The CVE.org part of a run (the second source), apart from the NVD part above.
 cvelist_last_finished_at:bigint('cvelist_last_finished_at',{mode:'number'}),
 cvelist_last_success_at:bigint('cvelist_last_success_at',{mode:'number'}),
 cvelist_last_status:text('cvelist_last_status'),
 cvelist_last_error:text('cvelist_last_error')
},()=>[
 check('vulnerability_sync_single_row',sql`id = 1`),
 check('vulnerability_sync_status_check',sql`last_status IS NULL OR last_status IN ('ok','failed')`),
 check('vulnerability_sync_cvelist_status_check',sql`cvelist_last_status IS NULL OR cvelist_last_status IN ('ok','failed')`)
]);
// The sync state per catalog product (lib/vulnerability-catalog.json).
export const vulnerabilityProducts=pgTable('vulnerability_products',{
 product_id:text('product_id').primaryKey().notNull(),
 cpe:text('cpe').notNull(),
 synced_at:bigint('synced_at',{mode:'number'}),
 full_synced_at:bigint('full_synced_at',{mode:'number'}),
 cve_count:bigint('cve_count',{mode:'number'}).notNull().default(0),
 // The matching rules (vulnerabilityRulesVersion) of the last full sync; another value forces a full sync.
 rules_version:integer('rules_version').notNull().default(0)
});
// The CVE.org sync state per catalog product (the second source).
export const vulnerabilityCvelistProducts=pgTable('vulnerability_cvelist_products',{
 product_id:text('product_id').primaryKey().notNull(),
 cpe:text('cpe').notNull(),
 synced_at:bigint('synced_at',{mode:'number'}),
 full_synced_at:bigint('full_synced_at',{mode:'number'}),
 cve_count:bigint('cve_count',{mode:'number'}).notNull().default(0)
});
// The CVEs of the catalog products. source names whose details the row holds:
// the NVD's whenever the NVD lists the CVE, else those of the CVE.org record.
export const vulnerabilities=pgTable('vulnerabilities',{
 cve_id:text('cve_id').primaryKey().notNull(),
 published:bigint('published',{mode:'number'}),
 last_modified:bigint('last_modified',{mode:'number'}),
 severity:text('severity').notNull(),
 score:doublePrecision('score'),
 vector:text('vector'),
 summary:text('summary').notNull(),
 known_exploited:smallint('known_exploited').notNull().default(0),
 fetched_at:bigint('fetched_at',{mode:'number'}).notNull(),
 source:text('source').notNull().default('nvd')
},()=>[
 check('vulnerabilities_id_check',sql`cve_id ~ '^CVE-[0-9]{4}-[0-9]{4,}$'`),
 check('vulnerabilities_source_check',sql`source IN ('nvd','cvelist')`),
 check('vulnerabilities_severity_check',sql`severity IN ('critical','high','medium','low','none','unknown')`),
 check('vulnerabilities_known_exploited_check',sql`known_exploited IN (0,1)`)
]);
// The affected versions of a CVE for one catalog product: an exact version,
// bounds, or neither (every version).
export const vulnerabilityRanges=pgTable('vulnerability_ranges',{
 cve_id:text('cve_id').notNull(),
 product_id:text('product_id').notNull(),
 version_exact:text('version_exact'),
 version_start:text('version_start'),
 start_inclusive:smallint('start_inclusive').notNull().default(0),
 version_end:text('version_end'),
 end_inclusive:smallint('end_inclusive').notNull().default(0),
 synced_at:bigint('synced_at',{mode:'number'}).notNull(),
 source:text('source').notNull().default('nvd')
},t=>[
 foreignKey({columns:[t.cve_id],foreignColumns:[vulnerabilities.cve_id]}).onDelete('cascade'),
 check('vulnerability_ranges_flags_check',sql`start_inclusive IN (0,1) AND end_inclusive IN (0,1)`),
 check('vulnerability_ranges_source_check',sql`source IN ('nvd','cvelist')`),
 index('idx_vulnerability_ranges_product').on(t.product_id,t.cve_id),
 index('idx_vulnerability_ranges_cve').on(t.cve_id)
]);
// The ancestor closure of a device group, depth 0 is the group itself.
export const deviceGroupAncestors=pgView('device_group_ancestors',{
 group_id:text('group_id').notNull(),ancestor_id:text('ancestor_id').notNull(),depth:bigint('depth',{mode:'number'}).notNull()
}).as(sql`SELECT group_id,ancestor_id,depth FROM device_group_paths`);
