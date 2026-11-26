# Dedicated terminal transport

**Remote › Terminal** shows the status pill and **Connect** in its head. When you are connected, **End session** replaces **Connect**. Warnings and errors show as notices above the shell. The table **Sessions on this device** shows the account, the time it opened, the last activity and the state. Its foot shows the number of active shells.

Each session row has one menu with these entries:

- **Resume**, for your own running shell that this view does not show.
- **End session** for your own shell, or **End session as admin** for the shell of another user. The admin entry asks first.

Agents that advertise `terminal-live` send and receive terminal frames only through `POST /api/agent/terminal`. The general `/api/agent/channel` continues to deliver jobs, transfers, drift policy and runbook schedules. For these agents, it does not return terminal commands and does not accept their reports. Existing protocol 3 agents keep the previous transport through the general channel.

The native service uses one terminal transport loop. For the exclusivity checks of jobs and updates, it uses an immutable published view of the registry. ConPTY output stops the wait of the transport. After a request completes, the next request starts a minimum of 80 milliseconds later. The endpoint has its own admission limit of 60 milliseconds.

Active idle shells request an interval of 180 milliseconds. Input and output traffic requests an interval of 100 milliseconds. When there is no shell, the discovery interval is one second. The HTTPS round trip and persistence add time to these values. They are not a measured latency guarantee on Windows.

The browser polls output every 100 milliseconds during typing or active output. It polls every 350 milliseconds while idle. It polls every second in a hidden tab or after a temporary transport failure. When the portal accepts input, it starts the reader immediately and does not wait for its idle timer. Keystrokes join only queued frames that the browser did not send yet.

After an HTTP attempt starts, the frame payload does not change. This also applies when a response is lost and the same sequence tries again. Xterm shows the real ConPTY output. Thus password prompts, cursor movement, tab completion and interactive applications work as on the host.

The two terminal transports use the same bounded exchange implementation. It has these rules:

- independent owners and contiguous input and output ACKs
- current device rights and local Management mode
- a hard lifetime of one hour and a browser presence of two minutes
- a limit of four shells
- no replay after an interruption
- exclusive agent updates

Agent traffic never extends the browser presence or the MFA inactivity deadline of the portal. A browser terminal request does one identity and session validation before its owner and device checks.

The terminal endpoint accepts only `{serverId, terminals}` and cannot carry jobs or transfer instructions. Its internal throttle key has the namespace `terminal:<device id>` in the existing `agent_channels` table. This table has no foreign key. The device authentication occurs before the endpoint selects that key. If no exchange is successful for 30 seconds, the transport failure closes the local shells. The agent checks a change of the locally protected mode to ReadOnly before and after each terminal request.

Validation: `node --experimental-strip-types tests/ui/devices/terminal-input.mjs`, the native protocol self-tests (wake coalescing, cancellation and concurrent registry inspection) and the server terminal tests. The real ConPTY latency and the browser keyboard and rendering need a Windows pilot.
