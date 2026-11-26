# Agent 4.7.0: SYSTEM broker and restricted worker

Up to 4.6.x, the full agent ran as one SYSTEM service. Portal communication, telemetry, file transfers, terminals, runbooks and the updater used one process. An attacker who took control of this process through a network or parser vulnerability had SYSTEM rights immediately. Since 4.7.0, the same EXE divides these tasks between two services.

| Service | Account | Task |
| --- | --- | --- |
| `ServerDeskAgent` (`--broker`) | LocalSystem | Runs jobs, terminals, file operations, drift scans, privileged telemetry and updates. Opens **no** network connection, only the local named pipe `ServerDesk.Broker`. |
| `ServerDeskWorker` (`--worker`) | `NT SERVICE\ServerDeskWorker` (virtual service account with its own service SID, only `SeChangeNotifyPrivilege`; since 4.7.3 service SID type "unrestricted", because Schannel makes no TLS connection with a write-restricted token) | The only process that communicates with the portal: heartbeat, job channel, live terminal, transfer data, release downloads. Member of "Performance Monitor Users" and "Event Log Readers" for the unprivileged telemetry. |

The worker depends on the broker. If you stop the broker with `-Force`, the worker also stops. The installer and the updater start both services.

## Trust boundary

The broker does not trust any data that comes through the pipe. Thus a worker under the control of an attacker can only start actions that the portal signed:

- **Signed envelopes.** The portal signs each job, each transfer offer, the drift policy and a terminal grant with ECDSA P-256 (`AGENT_JOB_SIGNING_KEY`). The envelope is `{payload, signature}`. `payload` contains `v`, `kind`, `deviceId`, `iat`, `exp` and the content. The broker checks the signature, the kind, the device ID and the lifetime. The lifetime is 15 minutes, for a terminal a maximum of 2 minutes, with ±2 minutes of clock skew. The broker uses only the signed content and never runs unsigned jobs.
- **Public key at installation.** The registration file contains `jobSigningKey` (SPKI, Base64). The installer keeps it in `config.bin`, which only SYSTEM and administrators can read. The worker does not get the key and cannot change it.
- **The device key stays in the broker.** Only `config.bin` contains the RSA key for the token renewal. The worker asks the broker to sign a renewal challenge through `sign-renewal`. Before it signs, the broker checks the purpose, the device ID and the portal origin of the challenge.
- **Terminal grant.** Each response from `/api/agent/terminal` contains a signed list of the sessions that can stay open (valid for 60 seconds). The broker closes sessions without a valid grant. Without a renewal, a session stops when its grant expires.
- **Releases.** The worker downloads updates. The broker reads them in parts through the pipe. As before, it checks the publisher signature, the hash and the size against the embedded publisher key.
- **Plugins.** Since 4.16.0, the broker runs signed agent plugins. It starts a plugin only for a signed job or the signed plugin policy. It checks the signature, the hash and the folder permissions before each start. The plugin runs in a job object, with firewall rules that block its network access. The worker cannot start a plugin and cannot give it an operation. For the details, refer to [Agent plugins](agent-plugins.md).
- **Pipe.** Only SYSTEM and the worker SID have access to the pipe. The broker also checks the identity and the image path of the client (`%ProgramData%\ServerDesk\current\ServerDesk.Agent.exe`). The worker checks that the pipe server is the running `ServerDeskAgent` process.

## File system

| Path | Access |
| --- | --- |
| `%ProgramData%\ServerDesk\` | SYSTEM and administrators (`config.bin`, jobs, claims, broker log `agent-v3.log`) |
| `…\current\` | Also the worker: read and run the EXE |
| `…\worker.bin` | Also the worker: read. Machine DPAPI. Contains only the device ID, the origin, the bearer and service tokens and the fingerprint of the device key |
| `…\plugins\` | Only SYSTEM and administrators, protected DACL without inheritance. One folder for each plugin with the EXE, `manifest.json` and `manifest.sig`. The worker has no access. |
| `…\worker\` | Worker data: token state, `v3-health.json`, `agent-worker.log`, temporary download files, .NET extraction `worker\runtime` |

The broker and the installer never write into `worker\`. Thus a link that the worker makes there cannot send a privileged write to a different location. The installer makes `worker\` again at each installation.

## Configure the portal

The portal needs its own ECDSA P-256 key. This key is different from the release publisher key.

- **Local:** `pnpm setup` makes `AGENT_JOB_SIGNING_KEY` in `.env.local`, also for a file that exists already.
- **NAS or container:** Make a key and write it as one line in `.env.runtime`:

  ```sh
  node -e "console.log(require('crypto').generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))"
  ```

  As an alternative, set `AGENT_JOB_SIGNING_KEY_FILE` to the path of a PKCS#8 PEM file.
- **Azure Container Apps:** Set `AGENT_JOB_SIGNING_KEY` as a secret reference. If it is missing, `deploy/azure.mjs` refuses the rollout.

Without the key, the portal makes no registration (HTTP 503) and does not answer channel requests from a 4.7 agent. If you change the key, you must install all agents again with a new registration file.

## Installation and migration

There is no automatic migration from 4.6.x. Do not use a portal update to 4.7.0. On the device, run these commands:

```powershell
& .\ServerDesk.Agent.exe --uninstall
& .\ServerDesk.Agent.exe --install --config .\ServerDesk-DEVICE.registration.json
```

Download the registration only after you configure `AGENT_JOB_SIGNING_KEY`. Remove the old device in the portal. A later repair with `--install` without a registration keeps the saved signing key.

## Watchdog

From agent 4.18.0, the broker and the worker watch each other:

- Every 15 seconds, the broker reads the state of the worker service. When the worker is stopped in two checks in a row and its start type is automatic, the broker starts it. It reports `service-restarted`. With the start type manual or disabled, it does nothing.
- Each request of the worker on the pipe is a sign of life. When a running worker made no request for 3 minutes, the broker ends its process. The failure actions of the service restart it, and the broker reports `service-hung`.
- When the worker process ends without the notice `worker-stopping`, the broker reports `service-ended`. The failure actions restart the worker; the broker does not.
- When every call of the worker to the broker fails for 3 minutes, the worker reports `broker-unresponsive` to the portal, once for each outage. The worker cannot start or end the broker, because it has no right to do so.

The watchdog does nothing during a shutdown, an agent update, a local installation or uninstall, or an uninstall from the portal. An uninstall stops the worker and then the broker under its maintenance marker, so nothing starts the worker again. Refer to [Tamper protection in 4.18.0](native-agent-v4.md#tamper-protection-in-4180).

The new pipe operations are `stop-context` (whether a stop is planned), `worker-stopping` (the clean end of the worker) and `integrity-ack` (the portal accepted these events). The `status` answer carries `integrity` and the pending `integrityEvents`, and `channel-state` carries `integrityPending`.

## Known gaps

- **Remote Desktop** is not available in the split agent. The device key opens the session key, and the WebRTC path would have to open the network from the broker. Thus the agent does not report the capability `rdp`.
- **Terminal input** has no signature for each keystroke. A worker under the control of an attacker can add its own input into a session that the portal opened. It cannot open a session without a grant.
- **Availability.** A worker under the control of an attacker can withhold jobs from the broker, change telemetry or send too many requests to the broker. The connections and the frame size have limits. The worker sees the telemetry and the transfer contents that it sends to the portal anyway.
- **Portal as signer.** An attacker who takes control of the portal runtime can still sign jobs. The split protects against an attack on the network path of the agent, not against a compromised portal.

## Checks on Windows

The build environment checks the protocol, the envelopes, the relay and the configuration with `--broker-self-test`. This includes a test vector that Node signed. You can check pipe ACLs, the virtual service account, group memberships and the service dependency only on Windows:

1. Make sure that `Get-Service ServerDeskAgent,ServerDeskWorker` shows both services as `Running`.
2. Make sure that `Get-CimInstance Win32_Service -Filter "Name='ServerDeskWorker'"` shows `StartName` `NT SERVICE\ServerDeskWorker`.
3. Make sure that the saved device snapshot (`servers.snapshot`) contains `agentIsolation` with `split: true` and `elevated: false`.
4. Make sure that `privileges` in this snapshot contains only `SeChangeNotifyPrivilege`, if possible.
5. Make sure that a refresh, a harmless job, a terminal, a file upload and a file download work.
6. Make sure that drift and an agent update to a later version work.
7. Make sure that `%ProgramData%\ServerDesk\worker\agent-worker.log` and `%ProgramData%\ServerDesk\agent-v3.log` contain no access errors.
