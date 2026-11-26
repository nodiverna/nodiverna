# AD sign-in for plugin changes

A technician who changes a Windows server through a plugin acts with an own AD account. The portal UI calls a plugin an extension, so the dialog says "Changes you make through an extension run with your AD account". The broker does not use its LocalSystem account for the change. The server checks the AD rights of the account, and the Windows Security log names the account. This applies to the DHCP plugin and the DNS plugin. Later plugins, for example a certificate authority, use the same mechanism without changes.

The technician signs in one time for each portal session and each domain. The first change on a server opens the dialog "Sign in to {domain}". After the sign-in, the account works on every server of that domain and for every plugin. It stays valid until the portal session ends, for at most 8 hours. The portal never stores a password.

Agent 4.19.0 adds this function. It reports the capability `plugin-ad-identity`. The DHCP plugin does not change.

## Options

Five designs were compared. The decision is option E.

| Option | Verdict |
|---|---|
| A. The AD password goes sealed with every job, and the broker calls `LogonUser` for each job | Rejected. The portal must keep the password for the whole session, or the user types it for each change. Both break "sign in one time". |
| B. Kerberos constrained delegation from the portal | Rejected. The portal is a Linux container, often far from the domain, without a KDC or a computer account. |
| C. Portal SSO (Entra ID or AD FS) and an AD group check, with the change still as SYSTEM | Rejected as the core. AD rights and the Windows audit do not apply, because the server sees SYSTEM. It stays the identity source for Entra users. |
| D. An LDAP bind check from the portal | Rejected. The portal has no LDAP path to the domain controllers, and the change still runs as SYSTEM. |
| **E. Prove the account one time, then S4U for each job** | Chosen. No stored password. AD rights apply, and a disabled, locked or deleted account fails at the next change. The plugin keeps its firewall block, because only lsass talks to the domain controller. One mechanism covers every plugin. |

## How it works

1. **Proof of the account.** The user types the account and the password in the dialog. The portal seals the password with the public key of the device and queues the job `ad-sign-in`. The broker opens the box and calls `LogonUserW` with a network logon. lsass checks the password with a domain controller. The broker reads the SID, `DOMAIN\name` and the UPN of the account. Then it closes the token and clears the password buffer.
2. **The session.** The device sends the identity back. The portal stores it in `plugin_ad_sessions` for the portal session and the directory SID. It stores no password.
3. **A change.** Each signed change job carries `actAs`: the session id, the user SID, the logon name, the account and the kind. The broker asks lsass for an S4U token of this account (`LsaLogonUser`, `KERB_S4U_LOGON` or `MSV1_0_S4U_LOGON`). It checks that the token SID is `actAs.userSid`. Then it starts the plugin with `CreateProcessAsUserW` and that token. Both tokens close after the run.

A read (`dhcp-read`, `dns-read`, `dns-zone-read`, **Read again**, the periodic read) still runs as SYSTEM and carries no `actAs`. Alerts and the plugin data keep working when no technician is present.

## The secret path

The password goes this way, and only this way:

- The browser sends it one time in the body of `POST /api/plugin-ad`, over HTTPS, at most 8 KiB.
- The portal seals it with the RSA key of the one device (`sealAgentSecrets`). The plaintext is not in `jobs`, `audit`, `plugin_ad_sessions`, the logs or an answer.
- The portal deletes the sealed box with the job parameters when the result arrives.
- The broker opens the box, gives the password to `LogonUserW` in an unmanaged buffer, and clears this buffer. `SecretMask` removes the password from the result and the message.
- The broker writes no password to its log.

## The plugin has no network

The plugin keeps its two firewall rules that block all traffic. The password check (`LogonUserW`) and the S4U logon are calls to lsass on the server. lsass, not the plugin, talks to the domain controller. An S4U token has no network credentials, so the plugin acts only on the local server.

The plugin runs as the user with a primary token, not as SYSTEM with impersonation. A code path that forgets to impersonate cannot fall back to SYSTEM. For this, the folder `plugins\` gives Authenticated Users read and execute. The plugin EXE is public signed code. Its DACL check stays the same, because read rights are not unsafe.

## Lifetime and offboarding

- A sign-in lasts as long as the portal (MFA) session, at most 8 hours.
- It is valid for one directory: the domain SID, or the machine SID of a workgroup server. It covers every device and plugin of that directory. Two customers with the same domain name have different SIDs, so their sign-ins never match.
- A sign-out of the portal, a revoked session or an expired session ends every AD sign-in of it.
- **Account → Server sign-ins** lists the sign-ins of this browser session. **Sign out** ends one.
- A disabled, locked or deleted AD account fails at the next change, because the S4U logon fails (`AGENT_PLUGIN_ACCOUNT_UNAVAILABLE`).
- A change job that waits while its sign-in ends is not sent. It is cancelled with "The job was not sent because its AD sign-in has ended.".

## Workgroup servers

A server that is not in a domain uses a local Windows account of that server in the same flow. The dialog says "Sign in to {device}" and takes `name` or `.\name`. The broker uses `MSV1_0_S4U_LOGON` for a change. A sign-in on a workgroup server works only for that server.

On a domain member, the broker refuses a local account of the server (`AGENT_AD_LOCAL_ACCOUNT`).

## The portal side

| Part | Behaviour |
|---|---|
| `POST /api/plugin-ad` `sign-in` | Checks in this order and writes nothing on a failure: plugin, right `<plugin>.manage`, online, `plugin-ad-identity`, reported directory, MFA, rate limit (5 failed sign-ins in 15 minutes), one sign-in at a time, account format and length, password, queue room. Then one transaction with the job and a pending row. |
| `GET /api/plugin-ad?jobId=` | The state of the own sign-in job: `pending`, `active` or `failed` with its code. |
| `GET /api/plugin-ad` | The active sign-ins of the current portal session. |
| `POST /api/plugin-ad` `sign-out` | Deletes one own sign-in and writes the portal audit row "AD sign-out". |
| DHCP changes | Every target device, the failover partner included, needs `plugin-ad-identity` and a sign-in. Without one, the answer is `PLUGIN_AD_SIGN_IN_REQUIRED` with the domain and the device. |
| DNS changes | The device needs `plugin-ad-identity` and a sign-in, as for DHCP. The DNS view shows the same account chip. |
| Claim | A change is sent only while its sign-in is active and its portal session is alive. The sign-in must belong to the portal user who queued the change. |

The device audit gets "AD sign-in" or "AD sign-in failed" with the target "{device} / {account}". A change names the account in its target, for example "SRV-DC01 / 10.10.0.0 (AD: CORP\anna)".

Wrong passwords count toward the lockout of the AD account. The portal rate limit stops a principal after 5 failed sign-ins in 15 minutes. Only a wrong account or password counts as a failed sign-in. A principal can have only one sign-in at a time. A second sign-in gets "Another sign-in is still being checked." until the first one has a result, or until the dialog cancels its job.

## In the console

- The DHCP view and the DNS view show the account chip before **Read again**. Without a sign-in, it shows **Sign in with AD account**.
- A change on a server without a sign-in opens the dialog first, then the confirmation. The confirmation shows the line **AD account**.
- When the server answers `PLUGIN_AD_SIGN_IN_REQUIRED`, the console opens the dialog and sends the same request one more time after the sign-in. An MFA prompt comes first.
- The dialog waits at most 60 seconds for the device. After that, it cancels the job and says that the device did not answer in time.

## Entra ID (Assumptions)

The portal sign-in will move to Entra ID in four steps. The design fits each step:

| Step | Change here |
|---|---|
| Entra sign-in | Calls `openDirectoryAdSession` after an Entra sign-in when `onPremisesSecurityIdentifier` and `onPremisesDomainName` are present. The hook makes an active row with `source:'entra'`. Hybrid users never see the dialog for their own domain. The app registration needs the optional claim `onprem_sid`, or a Graph read of these attributes. |
| Step-up as a fresh Entra sign-in | No change. |
| Graph check of accounts | Ends `source:'entra'` rows whose SID changed or whose account is disabled. Ended portal sessions end them through the foreign key. |
| Entra only | Keeps the password dialog for the break-glass Owner and for Entra users without a synced account. |
| Several customers | No change. Rows are per portal session and directory SID. |

The hook is built and tested now. The Entra sign-in connects it.

## DHCP AD authorization (Assumptions)

The AD authorization and deauthorization of a DHCP server stay read-only. This design does not cover them. `DhcpAddServer` writes over LDAP from the calling process, and an S4U token has no network credentials. A later job needs two parts:

- a firewall exception for the plugin to the domain controllers (LDAP, Kerberos, DNS) during these two operations only;
- Kerberos constrained delegation with protocol transition from the computer account of the server to `ldap/<DC>`, or the password again for this one operation.

## DNS zones in Active Directory (open point)

A DNS change runs with an S4U token of a network logon. The token has the NETWORK SID. So the WMI namespaces of the DNS server must allow **Remote Enable** for the account. DnsAdmins has this right by default, but a Windows run must prove it.

A change of a zone that Active Directory stores also needs dns.exe to accept the AD write under the S4U identity. The Windows acceptance run checks both points. The portal does not fall back to SYSTEM when they fail.

## Security notes

A compromised portal could ask for an S4U token of any domain account on a managed server. This gives no new power: the same portal can already run SYSTEM scripts and a terminal on that server.

The portal trusts the account that a server sends back after a sign-in: the user SID, `DOMAIN\name`, the UPN and the directory SID. A compromised server could send another account of the directory. Later changes would then run as that account, and the Windows Security log would name the wrong person. Thus a technician must sign in only on servers that they trust. The password also goes to that server, so this is the same trust boundary.

## Checks

- `tests/lib/plugin-ad.mjs`: account forms, the agent's account vectors, `security.directory`, the session match, the lifetime, `actAs`, the Entra mapping and the chip gate.
- `tests/api/plugin-ad-sessions.mjs`: the sign-in, the refusals, the rate limit, the results, sign-out, the cascade, the table constraints, the Entra hook and the claim guard on PostgreSQL.
- `tests/ui/devices/plugin-ad-view.mjs`: the dialog, the flow, the chip and the account card.
- `tests/api/dhcp-manage.mjs`: DHCP changes need the sign-in and carry `actAs`.
- `tests/api/dns-manage.mjs`: DNS changes need the sign-in and carry `actAs`.
- `ServerDesk.Agent.exe --plugin-self-test`: account parsing, the Win32 error map, the SID kind check, `actAs`, the access-denied rewrite, the DACL and the token lifetime with a fake token factory.

The Windows acceptance run needs an AD lab with a domain controller, a member DHCP server and a workgroup server. For DNS, it also needs a second domain controller with DNS and a member DNS server.
