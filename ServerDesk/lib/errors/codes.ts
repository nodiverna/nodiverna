// Machine-readable error codes of the portal API: the error contract between
// server and client. Each code has one HTTP status and a default message key
// (apiError.*, lib/i18n/messages/en-server.ts); lib/errors/api-error-keys.ts maps
// every key to its code. The client branches on `code`, never on message text,
// and shows the catalog text of the key in its own language. This module is
// shared with client components: it imports only the i18n catalog, so it never
// pulls lib/server/context.ts, next/*, cloudflare:*, runtime/* or the database into a
// bundle or a test.
import {defaultLocale} from '../i18n/locale';
import {translate} from '../i18n/translate';
import type {ApiErrorKey} from './api-error-keys';

/** The defaultLocale text of a key. */
const text=(key:ApiErrorKey)=>translate(defaultLocale,key);

// Texts that other modules export under their established names
// (lib/server/devices/device-groups.ts, lib/server/identity/customers.ts, lib/server/catalog-ownership.ts,
// lib/server/agent/customer-installers.ts). Code throws the keys; the text form
// of HttpError maps these texts back to their keys.
/** Triggers from 0029: groups, subgroups and memberships stay within one customer. */
export const customerMismatchMessage=text('apiError.customer.mismatch');
/** Trigger from 0031: a disabled customer takes no new devices or groups. */
export const customerDisabledMessage=text('apiError.customer.disabled');
/** Trigger from 0032: a membership must name an existing device and group. */
export const deviceGroupMemberMissingMessage=text('apiError.group.memberMissing');
/** 404: the customer does not exist (any more). Only for flows in which the viewer sees every customer (Owner only). */
export const customerMissingMessage=text('apiError.customer.gone');
/** 404: the customer does not exist or lies outside the viewer's boundary. Default text of CUSTOMER_MISSING. */
export const customerUnavailableMessage=text('apiError.customer.unavailable');
/** UNIQUE device_group_members.server_id: a concurrent request put the device into another group. */
export const deviceGroupMembershipTakenMessage=text('apiError.group.membershipTaken');
/** UNIQUE customers.name (NOCASE). */
export const customerNameTakenMessage=text('apiError.customer.nameTaken');
/** CHECK customer_installers_enrollments: the installer reached max_devices. */
export const installerExhaustedMessage=text('apiError.installer.exhausted');
export const customerRolePermissionsMessage=text('apiError.customer.rolePermissions');
export const customerRoleScopeMessage=text('apiError.customer.roleScope');
export const templateScopeCustomerMessage=text('apiError.customer.templateScope');
export const catalogOwnerImmutableMessage=text('apiError.customer.catalogOwnerImmutable');

type CatalogEntry={readonly status:number;readonly key:ApiErrorKey;readonly message:string};
/** status and default key. `message` is the defaultLocale text, kept for the text form of HttpError; client code shows the key. */
const entry=(status:number,key:ApiErrorKey):CatalogEntry=>({status,key,message:text(key)});

export const errorCatalog={
 // Generic answers of failure() in lib/server/context.ts.
 VALIDATION_FAILED:entry(400,'apiError.validationFailed'),
 /** The text takes the 8-character reference that is also logged as the param `reference`. */
 INTERNAL_ERROR:entry(500,'apiError.internalError'),
 STORAGE_UNAVAILABLE:entry(503,'apiError.storageUnavailable'),
 // Generic codes per status for errors that are no contract of their own.
 // No client and no agent branches on them, so a former code-less 401 or 403
 // neither locks the session nor opens the MFA dialog.
 INVALID_REQUEST:entry(400,'apiError.request.invalid'),
 UNAUTHORIZED:entry(401,'apiError.generic.unauthorized'),
 FORBIDDEN:entry(403,'apiError.policy.permissionMissing'),
 NOT_FOUND:entry(404,'apiError.generic.notFound'),
 CONFLICT:entry(409,'apiError.generic.conflict'),
 GONE:entry(410,'apiError.generic.gone'),
 PAYLOAD_TOO_LARGE:entry(413,'apiError.request.tooLarge'),
 RATE_LIMITED:entry(429,'apiError.generic.rateLimited'),
 BAD_GATEWAY:entry(502,'apiError.generic.badGateway'),
 SERVICE_UNAVAILABLE:entry(503,'apiError.generic.serviceUnavailable'),
 // Sign-in and session (lib/server/identity/local-auth.ts, lib/server/identity/mfa.ts). ui/base/http.ts locks the
 // session on IDENTITY_LOGIN_REQUIRED, MFA_LOGIN_REQUIRED and SESSION_EXPIRED.
 IDENTITY_LOGIN_REQUIRED:entry(401,'apiError.auth.loginRequired'),
 SESSION_EXPIRED:entry(401,'apiError.auth.sessionExpired'),
 INVALID_CREDENTIALS:entry(401,'apiError.auth.invalidCredentials'),
 AUTH_RATE_LIMITED:entry(429,'apiError.auth.rateLimited'),
 AUTH_STATE_CHANGED:entry(409,'apiError.account.stateChanged'),
 INVALID_ACCOUNT_TOKEN:entry(400,'apiError.account.invalidToken'),
 // MFA (lib/server/identity/mfa.ts, lib/server/automation/automation-runbooks.ts).
 MFA_LOGIN_REQUIRED:entry(403,'apiError.mfa.loginRequired'),
 MFA_STEP_UP_REQUIRED:entry(403,'apiError.mfa.stepUpRequired'),
 /** No MFA account although the session passed requireMfa: only after a concurrent MFA reset. */
 MFA_SETUP_REQUIRED:entry(403,'apiError.mfa.setupRequired'),
 // AD sign-in for plugin changes (lib/server/extensions/plugin-ad-sessions.ts): the console opens the sign-in dialog for params.serverId and resends once.
 PLUGIN_AD_SIGN_IN_REQUIRED:entry(403,'apiError.pluginAd.signInRequired'),
 // Terminal input sequence (app/api/terminal/route.ts). All four conflicts send this key;
 // the terminal panel shows its text and resyncs by itself.
 TERMINAL_SEQUENCE_CONFLICT:entry(409,'apiError.terminal.sequenceConflict'),
 // Agent requests: device tokens, registration and job signing (lib/server/agent/device-tokens.ts,
 // lib/server/agent/agent-dispatch.ts). The Windows agent branches on DEVICE_TOKEN_REJECTED.
 DEVICE_TOKEN_REJECTED:entry(403,'apiError.agent.tokenRejected'),
 DEVICE_REGISTRATION_EXPIRED:entry(403,'apiError.deviceToken.registrationExpired'),
 DEVICE_KEY_REQUIRED:entry(409,'apiError.deviceToken.keyRequired'),
 DEVICE_CHALLENGE_EXPIRED:entry(409,'apiError.deviceToken.challengeExpired'),
 DEVICE_CHALLENGE_CHANGED:entry(409,'apiError.deviceToken.challengeChanged'),
 AGENT_JOB_SIGNING_KEY_MISSING:entry(503,'apiError.signing.keyMissing'),
 AGENT_JOB_SIGNING_KEY_INVALID:entry(503,'apiError.signing.keyUnreadable'),
 // Agent uninstall (lib/server/agent/agent-channel.ts). The Windows agent branches on both codes.
 AGENT_UNINSTALL_CONFIRMED:entry(403,'apiError.agent.uninstallConfirmed'),
 AGENT_UNINSTALL_NOT_CONFIRMED:entry(409,'apiError.agent.uninstallNotConfirmed'),
 // Device removal and uninstall (lib/server/devices/device-lifecycle.ts).
 ACCESS_NOT_APPROVED:entry(403,'apiError.devices.removeApprovalChanged'),
 // Remote desktop (lib/server/devices/rdp.ts).
 RDP_FEATURE_PAUSED:entry(503,'apiError.rdp.paused'),
 // Desired State (lib/server/automation/desired-state.ts).
 DESIRED_CONFIGURATION_CHANGED:entry(409,'apiError.desired.configConcurrent'),
 DESIRED_EXECUTION_RUNNING:entry(409,'apiError.desired.deleteRunning'),
 DESIRED_ASSIGNMENT_CONFLICT:entry(409,'apiError.desired.otherVersionAssigned'),
 DESIRED_SCHEDULE_CONFLICT:entry(409,'apiError.desired.otherIntervalAssigned'),
 DESIRED_ASSIGNMENT_CHANGED:entry(409,'apiError.desired.assignmentChangedRestart'),
 DESIRED_APPROVAL_CHANGED:entry(409,'apiError.desired.approvalChanged'),
 DESIRED_DEVICE_BUSY:entry(409,'apiError.desired.deviceBusy'),
 // Cross-customer actions (lib/server/identity/cross-customer.ts).
 CROSS_CUSTOMER_FORBIDDEN:entry(403,'apiError.crossCustomer.right'),
 // Installer enrollment (lib/server/agent/customer-installers.ts).
 INSTALLER_INVALID:entry(403,'apiError.installer.invalid'),
 INSTALLER_REVOKED:entry(403,'apiError.installer.revoked'),
 INSTALLER_EXPIRED:entry(403,'apiError.installer.expired'),
 INSTALLER_GROUP_MISSING:entry(409,'apiError.installer.groupMissing'),
 INSTALLER_EXHAUSTED:entry(409,'apiError.installer.exhausted'),
 // Console enrollment (app/api/console, action 'enroll') once a second customer exists.
 ENROLL_CUSTOMER_REQUIRED:entry(400,'apiError.console.enrollCustomerRequired'),
 // Trigger conflicts (lib/server/errors/db-codes.ts).
 CUSTOMER_DISABLED:entry(409,'apiError.customer.disabled'),
 CUSTOMER_MISMATCH:entry(409,'apiError.customer.mismatch'),
 CUSTOMER_MISSING:entry(404,'apiError.customer.unavailable'),
 CUSTOMER_ROLE_PERMISSIONS:entry(400,'apiError.customer.rolePermissions'),
 CUSTOMER_ROLE_SCOPE:entry(400,'apiError.customer.roleScope'),
 CUSTOMER_CATALOG_MISMATCH:entry(400,'apiError.customer.templateScope'),
 CUSTOMER_CATALOG_IMMUTABLE:entry(400,'apiError.customer.catalogOwnerImmutable'),
 CUSTOMER_DEFAULT_PROTECTED:entry(409,'apiError.customer.defaultProtected'),
 // A customer delete while devices, groups, active catalog entries or roles hold the customer.
 CUSTOMER_IN_USE:entry(409,'apiError.customer.inUse'),
 CUSTOMER_INSTALLER_GROUP_MISMATCH:entry(400,'apiError.customer.installerGroupMismatch'),
 CUSTOMER_SETTINGS_INVALID:entry(400,'apiError.customer.settingsInvalid'),
 CUSTOMER_ASSIGNMENT_SUBJECT_MISSING:entry(409,'apiError.customer.assignmentSubjectMissing'),
 // The setting "Multiple customers" (lib/server/identity/multiple-customers.ts).
 MULTIPLE_CUSTOMERS_OFF:entry(409,'apiError.customer.multipleCustomersOff'),
 MULTIPLE_CUSTOMERS_IN_USE:entry(409,'apiError.customer.multipleCustomersInUse'),
 DEVICE_GROUP_CYCLE:entry(409,'apiError.group.cycle'),
 DEVICE_GROUP_DEPTH_LIMIT:entry(409,'apiError.group.depthLimit'),
 DEVICE_GROUP_HAS_CHILDREN:entry(409,'apiError.group.hasChildren'),
 DEVICE_GROUP_MEMBER_MISSING:entry(409,'apiError.group.memberMissing'),
 DEVICE_GROUP_MEMBERSHIP_PATH_CONFLICT:entry(409,'apiError.group.membershipPathConflict'),
 DEVICE_GROUP_PARENT_MISSING:entry(409,'apiError.group.parentMissing'),
 // Alert rule overrides (lib/server/devices/alert-rule-overrides.ts). The client shows its own localized text per code.
 ALERT_RULE_INVALID:entry(400,'apiError.alerts.invalid'),
 ALERT_RULE_CHANGED:entry(409,'apiError.alerts.changed'),
 ALERT_RULE_SCOPE_BOUNDARY:entry(403,'apiError.alerts.scopeBoundary'),
 // Alarms (lib/server/devices/alerts.ts): acknowledge, mute and unmute, and the alarm history.
 ALERT_INVALID:entry(400,'apiError.alarms.invalid'),
 ALERT_STATE_CHANGED:entry(409,'apiError.alarms.stateChanged'),
 // ESU dates (lib/server/devices/os-esu.ts) and the software report of the agent (lib/server/devices/software.ts).
 OS_ESU_INVALID:entry(400,'apiError.esu.invalid'),
 OS_ESU_CHANGED:entry(409,'apiError.esu.changed'),
 SOFTWARE_REPORT_INVALID:entry(400,'apiError.software.reportInvalid'),
 // Driver and autostart lists of the agent (lib/server/devices/drivers.ts, lib/server/devices/autostart.ts) and the confirmation of autostart entries. The client shows its own localized text per code.
 DRIVER_REPORT_INVALID:entry(400,'apiError.drivers.reportInvalid'),
 AUTOSTART_REPORT_INVALID:entry(400,'apiError.autostart.reportInvalid'),
 // GPU driver updates (lib/server/devices/gpu-drivers/device.ts): the console refuses an install-gpu-driver job with these codes.
 GPU_DRIVER_NO_GPU:entry(409,'apiError.gpuDriver.noGpu'),
 GPU_DRIVER_LOOKUP_FAILED:entry(502,'apiError.gpuDriver.lookupFailed'),
 GPU_DRIVER_UNSUPPORTED_OS:entry(409,'apiError.gpuDriver.unsupportedOs'),
 GPU_DRIVER_UNSUPPORTED_MODEL:entry(409,'apiError.gpuDriver.unsupportedModel'),
 GPU_DRIVER_NO_UPDATE:entry(409,'apiError.gpuDriver.noUpdate'),
 GPU_DRIVER_VERSION_CHANGED:entry(409,'apiError.gpuDriver.versionChanged'),
 GPU_DRIVER_ALREADY_INSTALLED:entry(409,'apiError.gpuDriver.alreadyInstalled'),
 GPU_DRIVER_JOB_ACTIVE:entry(409,'apiError.gpuDriver.jobActive'),
 AUTOSTART_CHANGED:entry(409,'apiError.autostart.changed'),
 AUTOSTART_NOTHING_TO_CONFIRM:entry(409,'apiError.autostart.nothingToConfirm'),
 // Device description and tags (lib/server/devices/device-description-store.ts, lib/server/devices/tag-store.ts). The client shows its own localized text per code.
 DEVICE_DESCRIPTION_INVALID:entry(400,'apiError.description.invalid'),
 DEVICE_DESCRIPTION_CHANGED:entry(409,'apiError.description.changed'),
 // Device name (lib/server/devices/device-name-store.ts).
 DEVICE_NAME_INVALID:entry(400,'apiError.deviceName.invalid'),
 DEVICE_NAME_CHANGED:entry(409,'apiError.deviceName.changed'),
 TAG_INVALID:entry(400,'apiError.tags.invalid'),
 TAG_NAME_TAKEN:entry(409,'apiError.tags.nameTaken'),
 TAG_LIMIT:entry(409,'apiError.tags.limit'),
 TAG_CHANGED:entry(409,'apiError.tags.changed'),
 // Maintenance (lib/server/maintenance.ts). The client shows its own localized text per code.
 MAINTENANCE_OWNER_ONLY:entry(403,'apiError.maintenance.ownerOnly'),
 MAINTENANCE_RETENTION_INVALID:entry(400,'apiError.maintenance.retentionInvalid'),
 MAINTENANCE_TIME_INVALID:entry(400,'apiError.maintenance.timeInvalid'),
 MAINTENANCE_TIME_ZONE_INVALID:entry(400,'apiError.maintenance.timeZoneInvalid'),
 MAINTENANCE_SETTINGS_CONFLICT:entry(409,'apiError.maintenance.settingsConflict'),
 MAINTENANCE_RUNNING:entry(409,'apiError.maintenance.running'),
 MAINTENANCE_MIGRATIONS_PENDING:entry(409,'apiError.maintenance.migrationsPending'),
 // Notification channels and rules (lib/server/notifications/notification-channels.ts, lib/server/notifications/notification-rules.ts). A failed test
 // message answers 422 NOTIFY_SEND_FAILED with the key of its reason (apiError.notify.<reason>).
 NOTIFY_CHANNEL_INVALID:entry(400,'apiError.notify.channelInvalid'),
 NOTIFY_CHANNEL_NAME_TAKEN:entry(409,'apiError.notify.channelNameTaken'),
 NOTIFY_CHANNEL_CHANGED:entry(409,'apiError.notify.channelChanged'),
 NOTIFY_SEND_FAILED:entry(422,'apiError.notify.connectFailed'),
 NOTIFY_RULE_INVALID:entry(400,'apiError.notify.ruleInvalid'),
 NOTIFY_RULE_CHANGED:entry(409,'apiError.notify.ruleChanged'),
 NOTIFY_RULE_EXISTS:entry(409,'apiError.notify.ruleExists'),
 NOTIFY_SCOPE_BOUNDARY:entry(403,'apiError.notify.scopeBoundary'),
 // The device assistant (lib/server/devices/assistant-settings.ts, lib/server/devices/assistant.ts). A failed provider call
 // answers 502 ASSISTANT_PROVIDER_FAILED with the key of its reason (apiError.assistant.<reason>).
 ASSISTANT_FORBIDDEN:entry(403,'apiError.assistant.forbidden'),
 ASSISTANT_FIELD_INVALID:entry(400,'apiError.assistant.fieldInvalid'),
 ASSISTANT_QUESTION_INVALID:entry(400,'apiError.assistant.questionInvalid'),
 ASSISTANT_NOT_CONFIGURED:entry(409,'apiError.assistant.notConfigured'),
 ASSISTANT_SETTINGS_CHANGED:entry(409,'apiError.assistant.changed'),
 ASSISTANT_RATE_LIMITED:entry(429,'apiError.assistant.tooManyQuestions'),
 ASSISTANT_CUSTOMER_KEYS_UNAVAILABLE:entry(409,'apiError.assistant.customerKeysUnavailable'),
 ASSISTANT_SECRET_UNDECRYPTABLE:entry(409,'apiError.assistant.secretUndecryptable'),
 // Commands of the assistant (docs/ai-assistant.md): a kind outside the allow-list, and a follow-up on a job that is not final.
 ASSISTANT_COMMAND_INVALID:entry(400,'apiError.assistant.commandInvalid'),
 ASSISTANT_FOLLOW_UP_INVALID:entry(409,'apiError.assistant.followUpInvalid'),
 ASSISTANT_PROVIDER_FAILED:entry(502,'apiError.assistant.providerUnavailable'),
 // The vulnerability check (lib/server/devices/vulnerabilities.ts). The client shows its own localized text per code.
 // Sign-in with Microsoft Entra ID (lib/server/identity/entra/). The ENTRA_CONFIRM_* codes and MFA_ENTRA_ONLY belong to "Confirm with
 // Microsoft" (lib/server/identity/entra/confirm.ts); none of them opens the MFA prompt, the confirmation dialog shows them itself.
 ENTRA_SETTINGS_INVALID:entry(400,'apiError.entra.tenantIdFormat'),
 ENTRA_TEST_FIRST:entry(409,'apiError.entra.testFirst'),
 ENTRA_SETTINGS_CHANGED:entry(409,'apiError.entra.settingsChanged'),
 ENTRA_MAPPING_CONFLICT:entry(409,'apiError.entra.mappingExists'),
 ENTRA_BUSY:entry(429,'apiError.entra.busy'),
 ENTRA_MANAGED:entry(403,'apiError.account.entraManaged'),
 MFA_ENTRA_ONLY:entry(400,'apiError.mfa.entraOnly'),
 ENTRA_CONFIRM_NOT_CONFIGURED:entry(409,'apiError.entra.confirm.notConfigured'),
 ENTRA_CONFIRM_EXPIRED:entry(409,'apiError.entra.confirm.expired'),
 ENTRA_CONFIRM_CANCELLED:entry(409,'apiError.entra.confirm.cancelled'),
 ENTRA_CONFIRM_REFUSED:entry(403,'apiError.entra.confirm.tokenRejected'),
 ENTRA_CONFIRM_UNAVAILABLE:entry(503,'apiError.entra.confirm.unavailable'),
 RBAC_ASSIGNMENT_FROM_ENTRA:entry(409,'apiError.rbac.assignmentFromEntra'),
 // Microsoft sign-in only and the emergency access (lib/server/identity/entra/emergency.ts): a refused switch,
 // emergency account choice or account, role or factor change.
 ENTRA_ONLY_REFUSED:entry(409,'apiError.entra.ownerSignInRequired'),
 // An emergency sign-in alarm that another Owner already acknowledged (lib/server/identity/security-alarms.ts).
 SECURITY_ALARM_CHANGED:entry(409,'apiError.alarm.changed'),
 VULNERABILITY_OWNER_ONLY:entry(403,'apiError.vulnerabilities.ownerOnly'),
 VULNERABILITY_SETTINGS_INVALID:entry(400,'apiError.vulnerabilities.settingsInvalid'),
 VULNERABILITY_SETTINGS_STALE:entry(409,'apiError.vulnerabilities.settingsStale'),
 VULNERABILITY_CHECK_OFF:entry(409,'apiError.vulnerabilities.checkOff'),
 VULNERABILITY_NOT_FOUND:entry(404,'apiError.vulnerabilities.notFound'),
 // Branding images (lib/server/branding-image.ts): the upload is no usable image, or larger than its slot allows.
 BRANDING_IMAGE_INVALID:entry(400,'apiError.branding.format'),
 BRANDING_IMAGE_TOO_LARGE:entry(413,'apiError.branding.logoTooLarge'),
 // The release source of Settings → Agent releases (lib/server/agent/release-source.ts).
 RELEASE_SOURCE_OWNER_ONLY:entry(403,'apiError.releaseSource.ownerOnly'),
 // UNIQUE and CHECK conflicts (lib/server/errors/db-codes.ts, dbConstraintCodes).
 DEVICE_GROUP_MEMBERSHIP_TAKEN:entry(409,'apiError.group.membershipTaken'),
 CUSTOMER_NAME_TAKEN:entry(409,'apiError.customer.nameTaken'),
} as const satisfies Record<string,CatalogEntry>;

export type ErrorCode=keyof typeof errorCatalog;

export function isErrorCode(value:unknown):value is ErrorCode{return typeof value==='string'&&Object.hasOwn(errorCatalog,value);}

/** The generic code of an HTTP status, for the text form of HttpError without a code. */
export function genericCodeFor(status:number):ErrorCode{return Object.hasOwn(genericCodes,status)?genericCodes[status]:status>=500?'SERVICE_UNAVAILABLE':'INVALID_REQUEST';}
const genericCodes:Readonly<Record<number,ErrorCode>>={400:'INVALID_REQUEST',401:'UNAUTHORIZED',403:'FORBIDDEN',404:'NOT_FOUND',409:'CONFLICT',410:'GONE',413:'PAYLOAD_TOO_LARGE',429:'RATE_LIMITED',500:'INTERNAL_ERROR',502:'BAD_GATEWAY',503:'SERVICE_UNAVAILABLE'};

/** The INTERNAL_ERROR text in defaultLocale with its reference filled in. */
export function internalErrorMessage(reference:string):string{return translate(defaultLocale,'apiError.internalError',{reference});}

/**
 * Whether the client opens the MFA dialog for an error with this code: a new
 * MFA login or a fresh step-up proof. MFA_SETUP_REQUIRED does not, because the
 * dialog cannot help without an MFA account.
 */
export function opensMfaPrompt(code:unknown):boolean{return code==='MFA_LOGIN_REQUIRED'||code==='MFA_STEP_UP_REQUIRED';}
/**
 * Whether the client opens the AD sign-in dialog for an error with this code
 * (docs/plugin-ad-sign-in.md): a plugin change without a matching AD session.
 * The MFA prompt comes first when both apply.
 */
export function opensAdSignIn(code:unknown):boolean{return code==='PLUGIN_AD_SIGN_IN_REQUIRED';}
