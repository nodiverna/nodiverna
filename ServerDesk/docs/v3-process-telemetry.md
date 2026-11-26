# Periodic process inventory

The native telemetry collector sends the current process list with each normal
30-second collection pass. The portal reads this list through its normal
console refresh. When you open or poll the Processes view, the portal does not
put diagnostic jobs into the queue. The explicit `list-processes` diagnostic
action stays available. Use it for a separate short CPU sample and for agents
without enriched process telemetry.

`snapshot.processes` keeps the compatible fields `name`, `pid`, `memoryMb` and
`cpuSeconds`. New agents also send these fields:

| Field | Meaning |
| --- | --- |
| `startedAt` | Exact native UTC process start timestamp. Present only when it matches the enumerated process identity. Guided termination needs it. |
| `parentPid`, `sessionId` | Parent process and Windows session from the current bulk inventory. |
| `user` | Cached process owner as `domain\user`, or null while it is not available or not resolved yet. |
| `path` | Executable path, or null when the agent cannot get access to it. Limit of 500 characters. |
| `cpuPercent` | Delta of the process CPU time since the previous valid collection, normalized to all logical CPUs. First and new samples, clock changes, gaps of more than 120 seconds and counter resets give null. |
| `protected` | Guided termination protection. Protected items are critical Windows and ServerDesk names, agent ancestry, agent data paths and critical-status checks that fail because of access. |

The agent collects no command lines, environment variables or process memory.
`cpuSeconds` is the cumulative CPU time of the process. It is not the
utilization at one point in time. The owner is the process identity, not each
user that a service serves.

`snapshot.processInventory` is optional, for compatibility with existing 3.0.1
agents. New agents send this object:

```json
{
  "collectedAt": "2026-10-08T08:00:00.0000000Z",
  "count": 214,
  "truncated": false,
  "complete": true,
  "intervalSeconds": 30
}
```

`count` is the number of processes in the full enumeration. `truncated` tells
that the sent list contains fewer rows because of the budget of the process
array. The budget is 5000 rows or 900000 bytes of UTF-8. `complete` means that
the enumeration was successful. The agent reports a truncation separately.

If the enumeration fails, the agent sends an empty list, count 0, complete
false and a bounded `error`. It does not show an old list as new, and the
failure does not stop the rest of the device heartbeat.

The collector makes one bulk `Win32_Process` query and one native process
enumeration for each pass. It keeps the ownership and the critical status in a
cache, with the PID plus the start identity as the key. It removes the entries
of processes that stopped. Each pass resolves a maximum of 64 new or missing
owners. It starts additional owner queries only in its first two seconds.

Each CIM owner query has an operation timeout of two seconds. The collector
tries failed owner queries again after five minutes. Missing owners stay null,
and later refreshes fill them gradually. The cache keeps the critical status
for five minutes, but guided termination always checks it again on the device.

The start timestamp uses the exact native FILETIME precision. Before the
collector shows the value, it compares the value with the CIM creation time.
For this comparison, it truncates the value to microseconds. The termination
action continues to compare `startedAt` against the same native process handle
that `Kill` uses. It also checks the Windows and agent protection again.

MFA, Management mode, device permissions and an explicit confirmation are
still necessary. Telemetry is read-only. It never sends or acknowledges
management work.

## In the portal

**Diagnostics › Processes** shows one row menu for each process, with **Show details** and **End process**. When the inventory has rows and every row is protected, the line above the table says this once: "Every process is protected and cannot be ended." Then the filter has no item **Protected**, and the rows show no shield.

**Diagnostics › Events** has the templates **Last 24 hours**, **Errors · 24 h** and **System starts · 7 days**. A template fills the fields and then runs the query once. When the query cannot run, for example on an offline device, the template tells you why and runs nothing. Opening the panel runs no query.

**Diagnostics › Connections** queries only on request. Before the first query, the empty table explains the query and offers **Query**, the same query as the toolbar button.

Run the compiled agent with `--self-test` to verify native sampling, reset and PID reuse, limits and provider timeout behavior. Use the Windows pilot in [native-agent-v4.md](native-agent-v4.md) to compare the real inventory against Task Manager. With this pilot, also verify the process identity before a termination test on a process that you can discard.
