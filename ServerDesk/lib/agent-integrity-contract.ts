// The integrity events of agent 4.18.0 (docs/native-agent-v4.md, "Tamper
// protection in 4.18.0"): the shared contract with the agent
// (agent/v3/AgentIntegrity.cs, IntegrityContract). Pure and without server
// imports: the telemetry schema, the alert rules, the issue texts and the route
// (lib/server/agent/agent-integrity.ts) use the same lists. tests/agent/agent-integrity-source.mjs
// checks that the C# lists are equal.

/** The event kinds. */
export const AGENT_INTEGRITY_KINDS=['service-stopped','service-ended','service-hung','service-restarted','broker-unresponsive','start-type-changed','agent-removed','protection-changed'] as const;
/** What a protection-changed event or a snapshot finding names. */
export const AGENT_INTEGRITY_TARGETS=['service-dacl','service-sid','service-recovery','folder-agent','folder-plugins','folder-staging'] as const;
export const AGENT_INTEGRITY_SERVICES=['broker','worker'] as const;
/** The start types of the heartbeat snapshot agentIntegrity. */
export const AGENT_START_TYPES=['auto','delayed-auto','manual','disabled','unknown'] as const;
/** The start types of a start-type-changed event: the agent no longer starts on its own. */
export const AGENT_INTEGRITY_EVENT_START_TYPES=['manual','disabled','unknown'] as const;
export const AGENT_INTEGRITY_REASONS=['local-uninstall','service-deleted'] as const;
/**
 * The kinds that the agent never creates in a planned context (shutdown, update,
 * install, uninstall) and that the portal stores as planned while an agent
 * update of the device runs or was claimed in the last 30 minutes.
 */
export const AGENT_INTEGRITY_STOP_KINDS=['service-stopped','service-ended','service-hung','service-restarted','broker-unresponsive'] as const;

export type AgentIntegrityKind=typeof AGENT_INTEGRITY_KINDS[number];
export type AgentIntegrityTarget=typeof AGENT_INTEGRITY_TARGETS[number];
export type AgentIntegrityService=typeof AGENT_INTEGRITY_SERVICES[number];
export type AgentStartType=typeof AGENT_START_TYPES[number];
export type AgentIntegrityReason=typeof AGENT_INTEGRITY_REASONS[number];

/** An integrity event keeps its alarm open this long after it reached the portal. */
export const AGENT_INTEGRITY_WINDOW_MS=24*60*60_000;
/** Stored events and the newest event per kind are read back at most this far (and deleted after it). */
export const AGENT_INTEGRITY_RETENTION_MS=90*24*60*60_000;
