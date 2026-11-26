# Portal login and browser sessions

ServerDesk authenticates its own username and password. A password verification creates a short, pending local primary session. This session does not open portal data. After a verification with TOTP, a recovery code or a passkey, the portal rotates the primary session. It binds the primary session to the exact hash of the MFA session.

Portal data APIs use `requireViewer`. It verifies the active local account, its primary session, the current rights and the matching live `mfa_sessions` token. A session with only a password cannot open device data. An MFA token from a different primary login also cannot open device data. Device bearer APIs continue to authenticate the native agent independently.

`requireIdentity` and `requireAuthIdentity` accept only local primary sessions. The identity and MFA routes use `requireAuthIdentity` before the MFA step. These routes cannot open device data.

The immutable principal of an account keeps the TOTP encryption, the recovery codes, the passkeys and the feature history.

Local primary sessions use the separate `__Host-serverdesk-auth` cookie. A pending login expires within ten minutes. A completed login keeps a fixed absolute limit of 24 hours. A successful MFA step rotates the primary bearer, but it does not make that original limit longer.

The MFA enrollment and the login issue a random session token of 256 bits. The database stores its SHA256 digest. The `__Host-serverdesk-mfa` cookie transports the token.

## Token transport

The session tokens travel only in HttpOnly cookies. These cookies are `__Host-serverdesk-auth` for the primary session, `__Host-serverdesk-mfa` for the MFA session and `__Host-serverdesk-mfa-grant` for the MFA grant. Each cookie has the settings `Path=/; Secure; HttpOnly; SameSite=Strict` and a `Max-Age`. A script on the page cannot read them.

No JSON reply contains a session token or a grant token. This applies to login, redeem, MFA login, activity, the status and the passkey login. The step-up `managementToken` stays in the JSON reply, because it is single-use, lives five minutes and is bound to the MFA session.

Headers never authenticate a portal session. The server reads the primary session only from its cookie, and the MFA session only from its cookie. A request without these cookies has no session, whatever headers it sends. A logout revokes only the sessions that the cookies of the request name.

The API helper of the browser keeps no token in memory. It sends `credentials: same-origin` and removes old credential headers that a caller adds. The browser stores no credential in localStorage. The origin checks on each write stay in force. The checks of the principal, the membership, the role, the session expiry and the revocation also stay in force.

A session expires after a configurable time without user activity. The default is 15 minutes, refer to "Automatic logout" below. The session also has a fixed absolute maximum of 24 hours. Portal polling, MFA status reads, terminal output and other GET requests do not make it longer.

Only `POST /api/mfa` from the same origin with `action: activity` makes the idle deadline later. This update needs an enrolled session that is live now. It cannot make an expired or revoked session live again. The activity timestamps come from the server. Concurrent requests cannot make an existing deadline earlier.

The client records real input before terminal textareas or dialogs stop the event bubbling. Synthetic input and events in hidden tabs never count. The client uses the server time and a monotonic browser clock. Thus corrections of the Windows clock do not make a session shorter or longer.

The client merges slow status replies with a session identifier that is not a bearer and with `lastActivityAt`. Thus slow replies cannot replace a newer activity deadline. Activity requests have a timeout of eight seconds. The client tries a request again only if it still represents input from the last thirty seconds.

After one minute without real input, the portal shows a small countdown in a corner. The countdown shows the time to the earlier server deadline, which is the idle deadline or the absolute deadline. Local input hides the countdown immediately. A newer activity timestamp from the server also hides it, also for activity in a different tab. The notice does not send requests or renew sessions. Its display timer pauses while the tab is hidden.

The account screen does not show a permanent footer with the session expiry.

A primary session that is bound to an MFA session is valid only while that MFA session is live. Thus the idle timeout, the absolute limit and each revocation of the MFA session also end the primary session. Then `GET /api/auth` returns no viewer, and the identity routes give `401 IDENTITY_LOGIN_REQUIRED`. The next sign-in starts with the password, as after **Sign out**. A pending primary session stays valid for its ten minutes.

`action: logout, idle: true` revokes the current session and deletes its cookie. A manual logout through `/api/auth` also revokes the local primary session and deletes its transport. Each logout that is not idle also deletes the MFA grant of the browser and clears its cookie. Changes to roles and group rights revoke all session rows and MFA grants of the affected principal.

When a user resets or removes an Authenticator, the portal revokes the other browser sessions and all MFA grants of the principal. The browser that confirmed the change keeps its current session. When a user adds or renames a method, the session does not become longer. When a user disables MFA, the portal revokes all tokens of that principal. After that, portal access stays locked until the user enrolls MFA again.

The historic `mfa_proofs` table stays available for older migrations. But its proofs with a lifetime of ten minutes cannot authenticate the current portal. Migration 0008 creates the new tables and does not copy proofs into sessions.

`GET /api/mfa`, the MFA login and activity return these values:

- `enabled`, `available`, `authenticated`, `verifiedUntil`, `idleExpiresAt` and `sessionExpiresAt`.
- `idleTimeoutMs` (the configured idle time in milliseconds).
- `serverTime`, `lastActivityAt` and the `sessionId`, which is not a bearer.

`verifiedUntil` is the earlier of the idle deadline and the absolute deadline. No reply returns a session token. If the session credentials are missing, the result is `403 MFA_LOGIN_REQUIRED`. An expired, revoked or foreign opaque session gives `401 SESSION_EXPIRED`. With these codes, and with `401 IDENTITY_LOGIN_REQUIRED`, the frontend unmounts the portal and shows the sign-in card.

The sign-in card is the normal **Sign in to Nodiverna** card, without a page reload. An info notice at the top tells the cause. After the idle time it says that the portal signed you out after that number of minutes. For all other causes it says that the session ended. A built-in account finds its username filled in and the focus in the password field. An Entra account gets **Sign in with Microsoft** as the primary action.

The `POST /api/mfa` action `resume` and the remembered browser of older versions are removed. The action `resume` gives the error of an unknown action. The server ignores a `remember24` field. Each reply that set or cleared the old cookie `__Host-serverdesk-mfa-trust` clears it one more time.

## What each sign-in asks for

The sign-in after the idle timeout and the sign-in after **Sign out** ask for the same factors. This table shows them for the same account in the same browser:

| Account | No live MFA grant, or the switch is on | Live MFA grant and the switch is off |
|---|---|---|
| Built-in, MFA enrolled | The password, then TOTP, a recovery code or a passkey | Only the password |
| Built-in, no MFA enrolled | The password, then the MFA setup, before any portal data | Not possible, because a grant needs enrolled MFA |
| Entra | A new Microsoft sign-in (`prompt=login`, `auth_time` check, `amr` with `mfa`) | The Microsoft sign-in without `prompt` (`amr` with `mfa` is still necessary) |

The switch is **Ask for MFA after an automatic sign-out**, refer to "MFA after an automatic logout" below.

An MFA grant is the record that an account completed MFA at sign-in in one browser. It stays valid for 8 hours. The constant `MFA_GRANT_LIFETIME_MS` in `lib/server/identity/session-settings.ts` holds this time, and `GET /api/session-settings` returns it as `mfaGrantHours`. Within these 8 hours, the next sign-in of the same account in the same browser asks only for the first factor. After 8 hours, the next sign-in asks for MFA again.

These sign-ins create a grant: a TOTP code, a recovery code, a passkey or the first MFA setup after the password, and an Entra sign-in with a new Microsoft sign-in. A step-up, an activity call, a status read and a sign-in through a grant never create a grant. They also never make a grant longer.

A session that a grant opens uses the configured idle time. Its absolute deadline is 24 hours after the MFA of the grant at the latest. Thus a grant never makes an MFA sign-in longer than 24 hours. A sign-in through a grant returns no `managementToken`.

These events end the grant early, in the same batch as the event:

- **Sign out** in this browser.
- A password change or a password reset link.
- An MFA reset: reset or removal of an authenticator, removal of a passkey, disabling MFA, or `reset-totp` of `scripts/selfhost.mjs`.
- The deactivation of the account, the Entra account check, sign-in with Microsoft turned off, and Microsoft sign-in only turned on.
- Each server action that ends all sessions of an account.
- A rise in privileges: role assignments, group rights, device group moves that give access, and customer technicians. For an Entra account, a role sync at a sign-in through a grant that adds an assignment also ends it.
- The switch turned on: this ends every grant of the installation.

The idle timeout and the absolute end of a session do not end the grant.

The grant is bound to its account. A grant of account A never skips MFA for account B in the same browser. The table `mfa_grants` stores the SHA256 digest of a random token of 256 bits, the principal, the account and the times. The cookie `__Host-serverdesk-mfa-grant` carries the token, with `Path=/; Secure; HttpOnly; SameSite=Strict` and a `Max-Age` up to the expiry.

While Microsoft sign-in only is on, the emergency access never gets or uses a grant. Each of its sign-ins asks for the password and the second factor.

## Why the two paths differed

The sign-in after the idle timeout forced a new Microsoft sign-in with `prompt=login` and a check of `auth_time`, so Microsoft asked for MFA again. The normal sign-in with Microsoft sent no `prompt`, so Microsoft could answer from its own session. That sign-in skipped no factor of the portal, because Entra accounts have no portal factors. Thus the idle path was the stricter one, and the difference was not a security bug.

## Sessions of Entra accounts

An account from Microsoft Entra ID signs in with Microsoft, refer to [entra-id.md](entra-id.md). After a valid sign-in, the portal creates the primary session and the MFA session in one step. The primary session is bound to the MFA session from the start. It never has a pending state.

The MFA of Entra counts as the MFA of the portal session. The account has no row in `mfa_accounts`, but the session checks accept the account as the anchor of its MFA session. A primary session of an Entra account without a bound MFA session is never valid.

The callback of the sign-in answers with a page of the portal and not with a redirect. The browser does not send `SameSite=Strict` cookies inside a redirect chain that started on another site. The page sets the session cookies and then opens the console.

The idle time and the absolute limit of 24 hours apply as for built-in accounts. After the idle time, the MFA session and the primary session end. The console shows the sign-in card with **Sign in with Microsoft**. This is the same start as a normal sign-in, refer to "What each sign-in asks for" above. A logout deletes both sessions and the MFA grant of the browser.

The account check ends the sessions of an Entra account within 15 minutes when Entra disables or deletes the account. It also ends them when the account leaves a mapped group, refer to [entra-id.md](entra-id.md#account-check).

## Sessions at the switch to Microsoft sign-in only

The switch to Microsoft sign-in only ends the sessions of each built-in account in the same step, refer to [entra-id.md](entra-id.md#microsoft-sign-in-only). This includes the primary sessions, the MFA sessions and the MFA grants. The sessions of the emergency access also end. The sessions of Entra accounts stay.

While the setting is on, the emergency access gets no MFA grant. Each of its sign-ins needs the password and the second factor.

## Automatic logout

A global Owner selects the idle time in the card **Session rules** of **Settings → Sessions**. The card holds the idle time and the switch for MFA after an automatic logout (see below). One **Save** sends both values in one request with one MFA confirmation.

The values are 5, 15, 30 or 45 minutes, and the default is 15. The value is in `identity_settings` under `session_idle_timeout_minutes`. A missing row or a value other than exactly `5`, `15`, `30` or `45` means 15 minutes. Thus a broken row never disables the timeout.

Each new MFA session uses the configured value. This includes a code, a recovery code, a passkey, a passkey setup and a sign-in through an MFA grant. Each `activity` call also uses the configured value. The absolute limit of 24 hours, the primary session of 24 hours and the MFA grant of 8 hours do not change.

`GET /api/session-settings` returns `idleTimeoutMinutes`, `options`, `defaultMinutes`, `idleRequiresMfa` and `mfaGrantHours`, but only to global Owners. The page sends `POST /api/session-settings` with `action: set`, `idleTimeoutMinutes`, `idleRequiresMfa` and a new `managementToken`. To change only the idle time, send `action: set-idle-timeout`, `minutes` and a new `managementToken`.

One batch does these steps:

- It writes the value. It compares the value with the value that it read before, and it checks the proof and the live Owner right.
- It writes the audit row with the stored audit action `Automatische Abmeldung geändert` and the target `<old> → <new> Minuten`.
- It limits each live MFA session to `min(idle_expires_at, last_activity + new timeout)`.
- It consumes the proof.

Thus a shorter value applies immediately to accounts that are already idle. The batch never makes a deadline later. The Owner who saves can continue to work, because the step-up renewed that session. Some sessions existed before the default changed from 60 to 15 minutes. They keep their deadline one time, because activity never makes a deadline earlier.

## MFA after an automatic logout

A global Owner sets the switch **Ask for MFA after an automatic sign-out** in the card **Session rules** of **Settings → Sessions**. The switch changes the form only. **Save** applies it. The switch applies to all accounts of the installation. The default is off.

While the switch is off, the MFA grant of 8 hours applies, refer to "What each sign-in asks for" above. While the switch is on, no grant is created or used. Thus every sign-in asks for MFA, also after the idle timeout and within the 8 hours. After the session ends, the server cannot tell an idle sign-in from other sign-ins, so the switch applies to each sign-in.

The value is in `identity_settings` under `session_idle_requires_mfa`. The exact text `0` and a missing row mean off. The text `1` and any other value mean on. Thus a broken row never makes the setting weaker.

When the Owner switches it on, the same batch deletes every grant of the installation. Live MFA sessions stay. When the Owner switches it off, the batch deletes nothing. Each grant insert and each sign-in through a grant check the stored value again in SQL. Thus a sign-in that commits after a switch to on creates and uses no grant.

Before the grant, the default of the switch was on, and the old `set` stored `1` each time an Owner saved the idle time. Thus a stored `1` did not show a choice of an Owner. The migration `0037_mfa_grants.sql` keeps the switch on only when the newest audit row `MFA nach automatischer Abmeldung geändert` has a target that ends with `→ an`. Else it writes `0`. A stored `0` stays `0`, and a missing row stays missing. The same migration drops the table of the remembered browsers.

To change only this value, send `POST /api/session-settings` with `action: set-idle-mfa`, `required` (a boolean) and a new `managementToken`. A value that is not a boolean gives `400` before the server reads the proof. An unchanged value returns the settings and keeps the proof. A concurrent change gives `409`.

One batch checks the proof, the live Owner right and the value that the server read before. The same batch writes the audit row `MFA nach automatischer Abmeldung geändert` with the stored target `an → aus` or `aus → an`. Then it writes the value and consumes the proof.

The action `set` changes both values with one proof. The server checks both values first. When nothing changed, it returns the settings and keeps the proof.

Else one batch checks the proof, the live Owner right and both values that the server read before. It writes one audit row for each changed value, with the same actions and targets as above. When the idle time changed, it limits the live MFA sessions. When the switch goes on, it deletes the MFA grants. Then it writes both values and consumes the proof one time.

A concurrent change gives `409`, and a missing proof gives a new MFA prompt.

## Which actions ask for MFA again

Each portal API needs the live MFA login session (`requireViewer`). Some actions also need a new step-up proof (`managementToken`). A proof is valid for 5 minutes and you can use it one time. `lib/step-up.ts` contains the classification. The server and the client read it from there, so they cannot have different lists.

The rule:

- An action with a real effect on devices or on security asks for MFA again, if it asked before. These actions change identities or permissions, sign-in factors or access credentials, remove devices, run code or change security settings.
- Organizing changes, notification changes and other changes that cannot run code, open access or make security weaker do not ask.
- An action whose effect depends on its target asks only in the risky case. The server examines the target again when it writes the change.
- All other actions use only the live MFA login session. No action asks for MFA if it did not ask before.

| Action (route, action) | Asks for MFA | Reason |
|---|---|---|
| `/api/rbac`, every action (user groups, members, roles, role assignments, customer members) | Yes | Identities and permissions |
| `/api/auth` `create-user`, `reset-link`, `update-user`, `disable-user` | Yes | Accounts of other users and access credentials |
| `/api/auth` `password-change` | Yes | Your own sign-in factor |
| `/api/mfa` `authenticator-begin`, `authenticator-delete`, `disable`, `regenerate-recovery` | Yes | MFA factors |
| `/api/passkeys` registration (`registration-options`, `registration-verify`) and `delete` | Yes | Passkeys |
| `/api/access` `set-grant`, `delete-grant` | Yes | Permissions |
| `/api/customers` `set-technicians` | Yes | Permissions of other users |
| `/api/session-settings` `set`, `set-idle-timeout`, `set-idle-mfa` | Yes | Sign-in settings |
| `/api/entra/settings` `save`, `set-enabled`, `add-mapping`, `remove-mapping`, `set-emergency-account`, `set-entra-only` | Yes | Sign-in settings and role mapping |
| `/api/assistant/settings` `set-organization-key`, `set-customer-key` | Yes | The key decides which provider account receives device data |
| `/api/console` `enroll` | Yes | Enrollment token |
| `/api/customers` `create-installer`, `revoke-installer` | Yes | Installers |
| `/api/customers` `delete` | Yes | Deletes a customer; the last delete ends the customer boundary ([customers.md](customers.md#delete-a-customer)) |
| `/api/customers` `set-multiple-customers` | Yes | The setting **Multiple customers** decides if the portal can have more than one customer ([customers.md](customers.md#multiple-customers)) |
| `/api/console` `remove-server`, `remove-servers` (with and without `uninstall`) | Yes | Removes or uninstalls agents |
| `/api/console` `move-customer` | Yes | Changes which technicians see the devices ([customers.md](customers.md#move-devices-to-another-customer)) |
| `/api/terminal` `open` | Yes (to resume your own live shell: no) | Remote SYSTEM shell |
| `/api/assistant` `run` with a PowerShell command | Yes | Runs code |
| `/api/maintenance` `set` | Only when the audit retention or the job retention gets shorter | A shorter retention deletes audit evidence. Run time and time zone cannot delete data |
| `/api/customers` `update` | Only when the customer audit retention gets shorter than the retention that applied before | Same as the maintenance settings. Name, contacts and maintenance window cannot delete data |
| `/api/access` `delete-group` | Only when the group has a device or a devicegroup role assignment | An empty group gives no access |
| `/api/access` `assign-device`, `set-device-memberships`, `update-device-memberships` | Only when the move gives more access | A move that gives more access opens access |
| `/api/customers` `create`, `set-status` | No | A new or deactivated customer opens no access and runs no code. The status does not change visibility ([customers.md](customers.md)) |
| `/api/notifications/channels` `create`, `update`, `delete`, `set-enabled`, `rotate-secret` | No | Notification changes have a low impact |
| `/api/assistant/settings` `remove-organization-key`, `remove-customer-key` | No | A removal only stops the assistant |
| `/api/branding` `PUT`, `DELETE` (portal logo, browser tab icon, customer logos) | No | A logo or an icon cannot run code, open access or make security weaker. The live MFA login session and the Owner right are enough ([branding.md](branding.md)) |
| `POST /api/branding/manage` (background choice, color scheme) | No | A background or a color scheme cannot run code, open access or make security weaker. The live MFA login session and the Owner right are enough ([branding.md](branding.md)) |
| `PUT /api/account/preferences` (console background of the account) | No | A personal display setting of the account. It changes nothing for other accounts ([branding.md](branding.md#backgrounds)) |
| `PUT /api/account/dashboard` (Dashboard layout of the account) | No | A personal display setting of the account. It changes nothing for other accounts ([dashboard.md](dashboard.md#customize-the-dashboard)) |
| `PUT /api/dashboard/default` (default Dashboard layout) | No | A tile order cannot run code, open access or make security weaker. The live MFA login session and the Owner right are sufficient ([dashboard.md](dashboard.md#default-layout)) |
| `PUT /api/account/pinned-devices` (pinned devices of the account) | No | A personal display setting of the account. It changes nothing for other accounts ([device-workspace.md](device-workspace.md#pinned-devices)) |
| `/api/rdp`; `/api/files`; `/api/transfers`; `/api/console` `job` and `defender-jobs`; `/api/diagnostics`; `/api/assistant` portal actions; `/api/runbooks`; `/api/automation`; `/api/desired-state`; `/api/dhcp`; `/api/dns`; `/api/releases`; `/api/plugins`; `/api/plugin-ad`; `/api/agent/download`; `/api/access` `create-group`, `update-group`; tags, notes, views, filters, alert rules, alarms, notification rules; `/api/mfa` `authenticator-rename`; `/api/passkeys` `rename` | No | These actions use the live MFA login session, the permissions, Management mode and the confirmations, as before |

Backups have no portal action, so the table shows none.

A device move gives more access when the device gets a new devicegroup role assignment in its target group. This role assignment is on the target group or on an ancestor. Before the move, the role assignment did not reach the device through its current group. When you remove devices from a group, access never becomes larger.

A device group is empty when it has no device membership and no devicegroup role assignment. Devices of every customer count, also devices that you cannot see. `GET /api/access` and the console data show `stepUpOnDelete` for each group. Without a proof, the delete of an empty group writes only if the group is still empty at the commit. If a device or an assignment arrives before the commit, the server deletes nothing and replies with `403 MFA_STEP_UP_REQUIRED`.

For the maintenance settings, the retention that applied before is the stored value, the environment value or the default value. No limit before is longer than any number. The `revision` of the settings keeps the decision correct until the commit. For a customer, the retention that applied before is its own value, else the audit retention of the instance. If the instance value changes before the commit, the edit fails as a stale change.

Routine writes still commit only behind the live primary session and MFA session (`mfaSessionFence`). Thus a logout, a password reset or an idle expiry before the commit stops them. The reply is then the session error, not a step-up error. A routine write ignores a supplied `managementToken`, and the proof stays valid.

A reply with `403 MFA_STEP_UP_REQUIRED` opens the confirmation dialog. The client then sends the same change one more time with the new proof. An action that always asks opens the dialog before it sends. An action that asks only in the risky case opens the dialog first only when the loaded data shows the risky case. If the client does not know the value that applied before, it sends without a proof, and the reply opens the dialog.

The risky cases, opening a terminal and enroll ask for MFA only after their validation and their existing checks. Thus a broken or forbidden request never asks for MFA first. The batch that writes the change consumes the proof.

Agent updates and agent plugins need no proof. If the MFA login session is not live, the reply opens the MFA dialog. After the MFA confirmation, the client sends the same request one more time. In the fleet view, one confirmation sends all release groups.

## How the browser handles API replies

API fetches use manual redirects. The portal API never sends a redirect and always replies with JSON. Thus the client changes these replies into a `502` without an error code:

- A redirect.
- A 401 or 403 that is not JSON.
- An HTML page from a proxy between the browser and the portal.

The message of this `502` is `The service cannot be reached at the moment. Try again.` It does not lock a session. An explicit server `401 IDENTITY_LOGIN_REQUIRED` offers the local login action with username and password.

Temporary upstream 5xx outages keep their failure status. They do not close an MFA session that is still live. Malformed API output gives a short API error, never raw exceptions of the JSON parser.

A request can fail with `MFA_LOGIN_REQUIRED` or `SESSION_EXPIRED` because a different tab has just replaced the shared cookie. Then the client sends one read-only `GET /api/mfa` with a limit of three seconds. Parallel failures share this check. If it reports `authenticated: true`, the UI synchronizes, else the portal locks. `IDENTITY_LOGIN_REQUIRED` locks without this check. The client never replays failed mutations.

When a check of the identity finds a different account, the portal shows the identity-change view. Recovery needs the local primary identity, the matching current viewer and its bound live MFA session. The check sends no request on mount and does no background polling. It never renews a session and never replays a mutation.

The protected download of the agent EXE is always the native download link of the browser. The HttpOnly cookies authenticate it.

HTML documents outside `/api/` now have the default `Referrer-Policy: strict-origin-when-cross-origin`. Requests to the same origin keep the ordinary referrer behavior. HTTPS requests to a different origin get only the site origin, without paths and query parameters. Requests from HTTPS to HTTP get no referrer. APIs and responses that are not HTML keep the `no-referrer` default. The explicit referrer policies of routes stay.

Referrer information never authorizes a request. The CSP baseline is added together with the existing route policies. Thus it cannot overwrite the image sandbox and script restrictions of the framework.

The baseline does not relax CSP ancestor restrictions, identity and MFA guards or session transports.
