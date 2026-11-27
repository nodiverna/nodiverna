# Windows diagnostics v3

The portal puts typed actions into the queue through `POST /api/diagnostics` with `{serverId,kind,params,confirm}`. The response contains the job ID. `GET /api/diagnostics?serverId=<id>&jobId=<id>` returns the scoped job and its structured output. Without `jobId`, the request returns up to 30 recent diagnostic jobs. It excludes output for which the viewer has no permission.

All requests use the existing authenticated identity. State changes need a same-origin request. Changes also need the device permission `manage`, a recent MFA, an explicit confirmation and locally enabled Management. Fixed diagnostics need `diagnose`. Security event data also needs `security.events`, for the queue request and for the read. The device must advertise a v3 capability.

## Actions and parameters

| Action | Parameters | Output |
| --- | --- | --- |
| `list-processes` | `limit` 1–1000, default 500; `sampleMs` 250–1000, default 350 | Processes: PID, parent PID, exact start timestamp, CPU delta during the sample, RAM, session, owner SID and name, executable path and guided kill protection |
| `kill-process` | `pid`, `startedAt`, `confirm:true` | Terminated or termination requested. The agent checks against the same process handle to prevent PID reuse |
| `list-sessions` | `{}` | WTS sessions, user name, client, state, idle and logon time, process IDs |
| `message-session` | `sessionId`, exact `username`, `message`, `confirm:true` | Windows action submitted |
| `disconnect-session` / `logoff-session` | `sessionId`, exact `username`, `confirm:true` | Windows action submitted. Refresh to verify the state |
| `list-connections` | `limit`, optional `pid` | TCP connections and UDP endpoints, linked to the current process owner and session. No bandwidth data |
| `network-diagnostics` | Optional `host`, `port` default 443 | IP addresses, routes, DNS configuration, WinHTTP proxy, listeners. Optional DNS resolution and bounded TCP probe |
| `query-events` | Filter below | Up to 100 events, cursor, scanned count and an indicator for more pages |
| `export-events` | `filter`, `format:json/csv/evtx` | Descriptor of a local staged file for the separate authenticated transfer flow |
| `support-bundle` | `channels` 1–3, default System/Application; `includeEvents` default true | ZIP with the selected event JSON, a bounded process inventory, sessions and network diagnostics. No agent credentials or configuration |

[`v3-process-telemetry.md`](v3-process-telemetry.md) describes the process list that the agent sends with each collection pass, without a diagnostic job.

The event filter has these fields: `channel`, optional ISO UTC/offset `from` and `to`, `levels` 0–5, optional `provider`, `eventIds` 0–65535, `text`, `limit` 1–100 and `includeXml`. It also has an optional `{channel,recordId,timeCreated}` cursor. Before the device goes to the next page, it verifies the anchor timestamp of the cursor against the current log. If somebody cleared or overwrote the anchor, the job fails with the code `AGENT_EVENT_CURSOR_INVALID` (`AGENT_EVENT_CURSOR_INVALID_CHANNEL` for a cursor of a different channel). The UI must then start again without its cursor.

Queries use the Windows event engine for system filters. For bounded free-text matching, they scan a maximum of 1000 records. They also limit the length of each description and XML. EVTX exports contain only the selected page and support system filters. They reject a free-text filter. JSON and CSV exports contain the selected result page, and an empty EVTX export returns a clear error.

## Agent and transport

`agent/v3/NativeDiagnostics.cs` handles each typed diagnostic job directly through Windows APIs. Successful data is `{kind,at,data,scope}`. The agent returns failures as failed job results. Native job results send this object as `data` through `/api/agent/channel`. The backend keeps the output separately in `job_outputs`, bound to the device and job ID. It gets the Security scope from the original job parameters before it clears the parameters.

The native diagnostic output has the limit of the existing 256 KiB channel contract. The agent runs no diagnostic script and no parameter file.

The agent creates files in `ServerDeskExports`, next to the agent data folder. The default is `C:\ProgramData\ServerDeskExports`, with ACLs only for SYSTEM and Administrators. Security exports have the fixed file name prefixes `security-events-` or `security-support-`. Thus the transfer route can keep the additional scope. Descriptors contain the path, the file name, the byte size, SHA-256 and the expiry.

Exports expire after one hour in the portal. The agent removes them locally after one day when somebody requests a different export. File transfer permissions continue to apply. A broad SYSTEM file read permission gives access to sensitive local data. Give it to operators only after careful thought.

CPU is a measured delta of the process time, normalized to all logical CPUs. Ownership is the current process identity. Shared service hosts can serve many users. Connection snapshots are not byte counters for each user. Precise traffic recording for each process stays a separate optional ETW recording function.

Guided process termination protects critical Windows names, agent binaries and worker ancestry. An explicitly authorized SYSTEM terminal can bypass guided controls. Treat such a terminal as full administrative access.

## Verification

Run `pnpm pipeline verify` for the current diagnosis client, the diagnostics view and workspace, the schema and the Node HTTP checks. The `--self-test` of the agent includes native diagnosis and storage fixtures. WTS, Windows events and real process operations need a Windows pilot on Server 2022, Server 2025 and Windows 11. Source and UI fixtures cannot replace this pilot.
