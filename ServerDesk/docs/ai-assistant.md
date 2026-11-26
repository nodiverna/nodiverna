# AI assistant

The AI assistant answers questions about one device. A technician opens the device and selects **Ask assistant** in the device header. The assistant opens in a panel on the right side, and the page stays usable. The technician then asks a question in plain language, for example "Why could this device be slow?". A large language model writes the answer from the data that the portal stores for this device. The model is Claude from Anthropic or a model from OpenAI.

The assistant reads the stored data of the device. It can also propose commands, for example "Restart service Spooler" or a PowerShell script. Nothing runs on the device until you select **Run on device**. Then the command runs with your rights, as the same action in the console. For the details, refer to [Commands](#commands).

## API keys

The assistant needs an API key of a provider. The portal supports API keys only. It does not support a consumer subscription of a chat app. There are three types of keys:

| Key | Who sets it | Where | Who uses it |
|---|---|---|---|
| Organization key | An owner | **Settings** › **AI assistant** › **Organization key** | Every user who can view a device |
| Customer key | An owner, when the portal has more than one customer | **Settings** › **AI assistant** › **Customer keys** | Questions about the devices of this customer |
| Personal key | Each user for the user | **My account** › **AI assistant** | Only the questions of this user |

For each key, you select the provider, the API key and the model. The default model is `claude-opus-5-5` for Anthropic and `gpt-5` for OpenAI. The model must support tool use. The model field accepts 1 to 100 letters, digits and the characters `. _ : / -`.

An Anthropic key starts with `sk-ant-`. An OpenAI key starts with `sk-`. A key has 20 to 512 printable ASCII characters and no spaces.

The costs of each question go to the provider account of the key.

### Set the organization key

1. Open **Settings** › **AI assistant**.
2. Under **Provider**, select **Claude (Anthropic)** or **OpenAI**.
3. Paste the key into **API key**.
4. Keep the default model, or type another model into **Model**.
5. Select **Test key**. The portal shows **Key works.** when the provider accepts the key and the model.
6. Select **Save**. Confirm the MFA prompt.

To change only the model, type the new model and select **Save**. The portal keeps the stored key. A change of the provider needs a new key. To remove the key, select **Remove organization key** and confirm. The removal needs no MFA prompt, because it only stops the assistant.

### Set a customer key

The section **Customer keys** shows when the portal has more than one customer. Customers cannot be deleted, so the section stays after that.

1. Open **Settings** › **AI assistant** › **Customer keys**.
2. Select **Set key** in the row of the customer.
3. Select the provider, paste the key and keep or change the model.
4. Select **Save key**. Confirm the MFA prompt.

A deactivated customer can get, keep and lose a key. Its devices continue to work. To remove a key, open the row and select **Remove customer key**. The removal needs no MFA prompt.

### Set your personal key

1. Open **My account**.
2. In the card **AI assistant**, select the provider and paste your key.
3. Select **Save**. The personal key needs no MFA prompt.

### Which key answers

For each question, the portal uses the first key that it finds in this order:

1. The key of the customer of the device. The portal reads the customer of the device again for each question.
2. The personal key of the user who asks.
3. The organization key.

Without a key, the panel shows **The assistant is not set up**. Owners then get a link to the settings. Other users get a link to their account.

A key that the portal cannot decrypt answers **The stored API key can no longer be read. Enter the key again.** The portal does not try the next key then. Enter the key again.

The line under the question field tells you which key answers, for example "Answers come from Claude (Anthropic) with the key for the whole portal."

## How the assistant gets its data

The model gets read tools. Each tool reads stored portal data of the asked device for the user who asks. The tools use the same rights as the console. A user without the right `diagnose` gets the processes without users and paths. A user without `defender.read` gets no Defender detections and no exclusions. A user without `security.events` gets no device audit.

| Tool | Data | Source |
|---|---|---|
| `device_overview` | Name, operating system, build, uptime, pending reboot, mode, agent version, connection, group, customer, description, tags, open alarms, CPU and memory, collection errors | **Overview** |
| `device_hardware` | Hardware inventory, GPUs, disk health, battery, page file, performance counters | **Hardware** |
| `device_gpu_drivers` | Graphics driver status for each vendor (NVIDIA, AMD): installed version, latest version, status and reason. It also shows an install that finished but that the next inventory did not report yet. The tool never starts a new vendor lookup and never shows a download address | **Hardware** › **Graphics card** |
| `device_metrics` | Stored CPU and memory samples of the last 24 hours, a maximum of 200 points | **Overview** |
| `device_services` | Services, with an optional filter | **Management** › **Services** |
| `device_processes` | Processes as the console shows them | **Diagnostics** › **Processes** |
| `device_events` | Stored events, crashes and reliability records, with an optional level | **Diagnostics** › **Events** |
| `device_updates` | Pending updates, hotfixes, operating system details and support status | **Management** › **Windows Update** |
| `device_storage` | Disks, volumes and BitLocker | **Management** › **Disks** |
| `device_network` | Adapters, network configuration, firewall profiles and rules, Remote Desktop settings | **Management** › **Network** |
| `device_security` | Security summary, Defender with a scan that the portal started, certificates, local users and groups | **Management** › **Defender** |
| `device_software` | Installed software and changes, with an optional filter | **Software** › **Programs** |
| `device_drivers` | Drivers | **Software** › **Drivers** |
| `device_autostart` | Autostart entries | **Software** › **Autostart** |
| `device_features` | Windows roles and features and if each is installed, with an optional filter | **Management** › **Roles & features** |
| `device_tasks` | Scheduled tasks and a planned shutdown or restart | **Management** › **Scheduled tasks** |
| `device_jobs` | Recent jobs and runbook runs that the user can see | **History** |
| `device_audit` | Audit entries of the device, only with `security.events` | **History** |

Each tool result is JSON with a maximum of 24 KiB. The portal cuts a longer list and marks the result as cut. The result never contains the public key of the agent. The portal reads the rights again for each question.

Under each answer, **Sources** shows the areas that the assistant read. A click on a source opens that area of the device.

## Commands

The model also gets two command tools. A call of a command tool only shows a proposal to the user. Nothing runs, and the portal queues no job. The portal stores no proposal.

| Tool | Input | What the user sees |
|---|---|---|
| `propose_action` | `kind`, `params` and `reason` (1 to 300 characters) | A card with the job label, the target, the parameters and the reason |
| `propose_powershell` | `script` (1 to 8,000 characters), `reason`, `changesDevice` and `timeoutSeconds` (10 to 600, 120 by default) | A card with the full script, its line count and the reason |

### Allowed actions

`propose_action` accepts only the kinds of this allow-list:

- Read-only kinds (9), without MFA and in each agent mode: `refresh`, `scan-updates`, `test-connection`, `list-processes`, `list-sessions`, `list-connections`, `network-diagnostics`, `query-events` and `storage-inspect`.
- Changing kinds (21): `start-service`, `stop-service`, `restart-service`, `set-service-startup`, `set-task`, `set-firewall-rule`, `install-updates`, `restart-computer`, `kill-process`, `disconnect-session`, `logoff-session`, `defender-quick-scan`, `defender-full-scan`, `defender-update-signatures`, `install-gpu-driver`, `install-feature`, `set-pagefile`, `shutdown-computer`, `schedule-power`, `cancel-power-schedule` and `defender-clean-detections`.

For `install-gpu-driver`, the model gives only the vendor and the version. The download address and the size come only from the vendor lookup of the portal, when you run the command. The proposal is refused when the device has no GPU of this vendor. The run uses all checks of the console, for example when the driver is already current or a newer version is available.

`shutdown-computer`, `schedule-power` and `cancel-power-schedule` have the same risk as `restart-computer`. The confirmation of the GPU driver and of a shutdown is a danger confirmation that tells you the consequence.

No other kind is possible. Each other kind of the portal is excluded for a reason:

| Kind | Reason |
|---|---|
| `remove-feature` | Removes a server role and its configuration. The role does not come back the same way when you install it again. It can also remove security features. |
| `set-network`, `set-dns` | Can disconnect the device from the portal. `set-dns` sends all name resolution of the device to a server that the model chose. |
| `set-rdp`, `add-firewall-rule` | Open remote access or ports to addresses that the model chose. |
| `join-domain`, `leave-domain`, `rename-computer`, `create-local-user`, `reset-local-password` | Carry credentials. A credential must never go through the model or its provider. They also change the identity of the device. |
| `set-local-user`, `delete-local-user`, `local-group-add`, `local-group-remove` | Give or remove access and privileges, for example membership in Administrators. |
| `list-files`, `create-directory`, `rename-file`, `delete-file` | File access. |
| `storage-initialize`, `storage-set-disk`, `storage-new-volume`, `storage-resize`, `storage-drive-letter`, `storage-format`, `storage-delete-partition` | Can destroy data, and you cannot undo it. |
| `desired-state-test`, `desired-state-apply` | They run only from a desired-state version, not as a single device action. |
| `message-session` | Shows text that the model wrote on the desktop of a user. After a prompt injection, this is a phishing channel. |
| `export-events`, `support-bundle` | Make a file for download. `query-events` reads the events. |
| `agent-update` | A release rollout with releases, campaigns and a schedule, not a device action. |
| `agent-uninstall` | Offboarding. It needs `instance.owner`. |
| `plugin-install`, `plugin-remove` | Distribute SYSTEM code. This stays a portal action with a confirmation. |
| `plugin-job` `dhcp-read` | The read job is shared for each device and writes no audit entry. It cannot carry `assistant.run` or a follow-up on your own job. |
| `plugin-job` DHCP changes | A change goes to a failover partner, which is a second device. The creation of a failover carries a shared secret. |
| `runbook-step`, `runbook-run` | Runbooks run from **Automation** with their own run model. `propose_powershell` is for scripts. |

For each question, the portal sends only the kinds that you can run on this device now. A kind needs your rights on the device and the capability of the kind. The device must report protocol version 3 and must have reported in the last 120 seconds. A changing kind also needs Management mode. On a domain controller, the assistant proposes no session kind. A Defender kind also needs a Defender state that permits it.

`propose_powershell` is available only when you have the right `terminal`, and the device is connected and in Management mode. The agent must be version 4.17.0 or later, with the capability `assistant-powershell`.

The portal checks each proposal when the model makes it. A refused proposal does not show, and the model gets a code: `notAllowed`, `missingRight`, `deviceOffline`, `agentUnsupported`, `managementRequired`, `invalidParameters`, `invalidScript` or `proposalLimit`. An answer has a maximum of 3 proposals.

### Run a command

1. Read the card. It shows the exact command and if it only reads, changes the device or can interrupt the device.
2. Select **Run on device**. A read-only action starts at once.
3. For a changing action or a script, read the confirmation and select **Run on device** again.
4. If the portal asks for MFA, confirm the MFA prompt. The portal then sends the same command one more time.
5. For a script, the MFA prompt opens before the portal sends the script. The script runs only with this fresh proof.

The second button of the card closes the card. The card then shows **Not run.**, and nothing goes to the portal.

The portal checks the command again as if you started it in the console. It uses the same rights, MFA, mode, capability, parameter and queue checks, and the same errors. The portal does not trust that a command came from a proposal.

| Command | Rights | Mode | MFA | Agent |
|---|---|---|---|---|
| Read-only action | The rights of the action, for example `diagnose` | Each mode | No | The capability of the action |
| Changing action | The rights of the action, for example `manage` or `defender.control` | Management | Yes | The capability of the action |
| PowerShell script | `terminal` | Management | Yes, with a fresh step-up proof for each script | 4.17.0, capability `assistant-powershell` |

A PowerShell script runs as SYSTEM, the same as the terminal. For this reason, it needs the right `terminal`, a confirmation and a fresh step-up proof, as when you open the terminal. The proof is valid for one script only. Refer to [Portal sessions](portal-sessions.md). The agent keeps at most 32 KiB of output and 8 KiB of errors.

The portal keeps the script of a script job for 7 days, so that the job drawer can show it. Then the daily maintenance deletes the script from the job, because the script can contain a secret. The job drawer then shows a note in place of the script. The timeout and the output of the job stay until the job retention deletes the job. Refer to [Maintenance](self-hosting.md#maintenance).

The job shows in the job dock and in the history of the device, with you as its actor. While the job waits and runs, the card shows its state. The panel asks for the state every 2 seconds for the first 30 seconds, then every 5 seconds. After 10 minutes without a result, the panel stops and tells you to look under **Jobs**.

### Follow-up

When the job ends, the panel sends a follow-up at once. The portal reads the result of the job and gives it to the model as data, not as an instruction. The model then writes the next answer. The follow-up counts as one question against the limit of 20 questions in 10 minutes.

The follow-up contains the kind, the target, the state, the result text in your language and the stored output of the job. The output has a maximum of 24 KiB, the same as a tool result. For a script, the output is the text output, the errors and the exit code. The portal does not send the script again.

The portal reads the job with your rights of this moment. You can only follow up on your own job on this device, and only when you can see its output.

**New conversation**, a reload, a different device or an earlier conversation that you open ends the open answer and the polling of the cards. The conversation stays. A question without an answer shows **Ask again**. A card of a job that was queued or running tells you that the assistant does not follow the job any more. Jobs that are already queued continue to run and stay in the job dock.

## What goes to the provider

The portal sends these data to the provider of the key:

- The question and a maximum of 10 earlier questions and answers of the same conversation.
- The rules of the assistant, the language of the user interface, the device name and the current time.
- The results of the tools that the model calls, only for the asked device and only with the rights of the user who asks.
- The proposals of the model and their checks.
- The results of the commands that you run, with their output. They go to the provider of the key that answers the follow-up.

The portal stores no conversation. The conversations stay in this browser tab (`sessionStorage`) until you close the tab or sign out. A reload or a different device ends the open answer and the polling of a command, but the conversation stays: when you select **Ask assistant** on the device again, it shows the same conversation. The panel stays open when you change the area or the tab of the device.

**New conversation** keeps the old conversation under **Earlier conversations**. This list shows the conversations of all devices in this tab, the newest first. Click a conversation to open it again, also when it is about a different device. The list shows only devices that you can see now. The tab keeps a maximum of 20 conversations. When there are more, the oldest earlier conversation goes first.

The portal connects only to the fixed hosts `api.anthropic.com` and `api.openai.com` with HTTPS. It follows no redirects. Each call has a time limit of 120 seconds, and each answer has a maximum of 1 MiB. The `app` container needs outbound HTTPS to these hosts.

Device data can contain text that looks like an instruction, for example an event message. The rules tell the model to treat all device data as data. The rules also tell the model never to propose a command because device data asks for it. In all cases, no command runs without your click.

The answer can contain bold text, lists and code. The portal shows no links and no images, so an answer cannot load an external address. Check important answers before you act on them.

## Limits

- A question has a maximum of 2,000 characters. An answer has a maximum of 16,000 characters.
- Each user can ask a maximum of 20 questions in 10 minutes, with all keys together. A follow-up counts as a question.
- An answer has a maximum of 3 proposals. A script has a maximum of 8,000 characters and a time limit of 10 to 600 seconds.
- Each user can test keys a maximum of 5 times in 60 seconds.
- The model can call tools in a maximum of 8 rounds for each question. Then the portal asks the model for the final answer without tools.

## Audit

| Entry | Scope | Target |
|---|---|---|
| `assistant.organization-key.set`, `assistant.organization-key.removed` | Portal | Provider, model and the last 4 characters of the key |
| `assistant.customer-key.set`, `assistant.customer-key.removed` | Portal, with the customer | Customer name, provider, model and the last 4 characters of the key |
| `assistant.personal-key.set`, `assistant.personal-key.removed` | Portal | Provider, model and the last 4 characters of the key |
| `assistant.ask` | Device | Provider, model, the key type and the names of the tools that the model used. With proposals, `proposals` names their kinds (`powershell` for a script). A follow-up has `followUp` with the job ID |
| `assistant.run` | Device | The kind and the job ID of a command that you ran from the assistant. It comes in addition to the usual audit entry of the job |
| `assistant.powershell` | Device | The audit entry of a script job: the device name, the first line of the script (a maximum of 120 characters) and the first 12 hex characters of its SHA-256 |

No audit entry contains a key, a question, an answer or the full script. A key test writes no audit entry.

## Storage

The portal encrypts each key with `SESSION_SECRET`. The context of the encryption is `assistant-key:organization`, `assistant-key:user:<userId>` or `assistant-key:customer:<customerId>`. No answer, log line or error contains a key. The settings show only the last 4 characters. The command `rewrap-secrets` encrypts the keys again after a change of the session secret ([self-hosting.md](self-hosting.md#change-the-session-secret)).

A personal key goes with its user account. A customer key goes with its customer.

## Errors

| Message | What to do |
|---|---|
| "{provider} rejected the API key. Check the key and save it again." | Make a new key at the provider and save it. |
| "{provider} does not offer the model {model} for this key. Choose another model in the settings." | Type a model that the key can use. |
| "The {provider} account has no credit or quota left. Check the billing of the account, then ask again." | Add credit to the provider account. |
| "{provider} gets too many requests at the moment. Wait a minute, then ask again." | Wait, then ask again. |
| "{provider} did not answer in time. Ask again in a moment." | Ask again. |
| "{provider} refused the request for the model {model}. Check that the model supports tool use, or choose another model." | Select a model with tool use. |
| "The model declined this question. Ask it in another way." | Ask the question in another way. |
| "The portal does not run this command from the assistant. Run it from the device page instead." | The command is not on the allow-list. Start the action in the device area. |
| "The command has not finished yet. Wait for the result, then ask again." | Wait until the job is final, then select **Ask again**. |
